(function(root, factory){
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var api = factory(
    isNode ? require("./migration-adapter.js") : root.BooktokkiMigrationAdapter,
    isNode ? require("./migration-dry-run.js") : root.BooktokkiMigrationDryRun,
    isNode ? require("./cloud-restore.js") : root.BooktokkiCloudRestore,
    isNode ? require("./cloud-bootstrap.js") : root.BooktokkiCloudBootstrap,
    isNode ? require("./legacy-recovery.js") : root.BooktokkiLegacyRecovery
  );
  if (isNode) module.exports = api;
  else root.BooktokkiConflictResolution = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter, dryRun, cloudRestore, bootstrap, backup){
  "use strict";

  if (!adapter || !dryRun || !cloudRestore || !bootstrap || !backup){
    throw new Error("Conflict resolution dependencies are required");
  }

  function clone(value){ return structuredClone(value); }
  function same(left, right){ return JSON.stringify(left) === JSON.stringify(right); }
  function decodeBytes(value){
    if (typeof atob === "function"){
      var text = atob(value), bytes = new Uint8Array(text.length);
      for (var i=0;i<text.length;i++) bytes[i] = text.charCodeAt(i);
      return bytes;
    }
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
    throw new Error("No base64 decoder");
  }
  function replaceStores(database, books, images){
    var stores = images ? ["books", "images"] : ["books"];
    return new Promise(function(resolve, reject){
      var tx, settled = false;
      function fail(error){ if (settled) return; settled=true; reject(error || new Error("Local replacement failed")); }
      try { tx = database.transaction(stores, "readwrite"); }
      catch (error){ fail(error); return; }
      tx.oncomplete = function(){ if (!settled){ settled=true; resolve(); } };
      tx.onabort = function(){ fail(tx.error || new Error("Local replacement transaction aborted")); };
      tx.onerror = function(){};
      try {
        var bookStore = tx.objectStore("books");
        bookStore.clear();
        books.forEach(function(book){ bookStore.put(clone(book)); });
        var bookCheck = bookStore.getAll();
        bookCheck.onsuccess = function(){
          var actual=(bookCheck.result||[]).slice().sort(function(a,b){return a.id.localeCompare(b.id);});
          var expected=books.map(clone).sort(function(a,b){return a.id.localeCompare(b.id);});
          if (!same(actual,expected)) try { tx.abort(); } catch (error){ fail(error); }
        };
        bookCheck.onerror = function(){ try { tx.abort(); } catch (error){ fail(error); } };
        if (images){
          var imageStore=tx.objectStore("images");
          imageStore.clear();
          images.forEach(function(image){ imageStore.put(image); });
          var imageCheck=imageStore.getAll();
          imageCheck.onsuccess=function(){
            var actualImages=imageCheck.result||[];
            if (actualImages.length!==images.length) try { tx.abort(); } catch (error){ fail(error); }
          };
          imageCheck.onerror=function(){ try { tx.abort(); } catch (error){ fail(error); } };
        }
      } catch (error){ try { tx.abort(); } catch (_abortError){} fail(error); }
    });
  }

  async function restoreBackup(database, payload, userId){
    var receipt = await backup.verifyBackupPayload(payload, userId);
    if (!receipt) throw new Error("Backup verification failed");
    var images=(payload.local.images||[]).map(function(image){
      return { id:image.id, blob:image.data == null ? null : new Blob([decodeBytes(image.data)], {type:image.type||""}) };
    });
    await replaceStores(database, payload.local.books||[], images);
    var restored=await dryRun.readLocalMigrationSnapshot(database);
    var check=await backup.createBackupPayload(restored, payload.cloud, userId);
    if (check.localManifestHash!==payload.localManifestHash || check.local.books.length!==(payload.local.books||[]).length
        || check.local.images.length!==(payload.local.images||[]).length){
      throw new Error("Restored backup verification failed");
    }
    return { success:true, receipt:receipt, local:restored };
  }

  async function prepare(options){
    var snapshots=await Promise.all([
      dryRun.readLocalMigrationSnapshot(options.database),
      dryRun.readCloudMigrationSnapshot(options.client, options.userId)
    ]);
    var owner=bootstrap.readLocalOwner(options.storage);
    var journal=dryRun.readMigrationJournal(options.storage, options.userId);
    var inspected=await bootstrap.inspectBootstrapState({
      localSnapshot:snapshots[0], cloudSnapshot:snapshots[1], userId:options.userId, journal:journal, owner:owner
    });
    if (inspected.state!==bootstrap.STATES.CONFLICT) throw new Error("Only a validated CONFLICT can be resolved");
    var validation=await cloudRestore.validateCloudRestoreSnapshot(snapshots[1], options.userId);
    if (!validation.valid || snapshots[0].books.length===0 || snapshots[1].books.length===0){
      throw new Error("Conflict snapshots are not eligible");
    }
    var payload=await backup.createBackupPayload(snapshots[0], snapshots[1], options.userId);
    var receipt=await backup.verifyBackupPayload(payload, options.userId);
    if (!receipt) throw new Error("Local backup verification failed");
    return {
      state:"READY", userId:options.userId, localSnapshot:snapshots[0], cloudSnapshot:snapshots[1],
      baselineCloudHash:backup.baselineHash(snapshots[1]), backupPayload:payload, backupReceipt:receipt,
      reconstructed:validation.reconstructed, backupDownloaded:false, destructiveAttempted:false
    };
  }

  function downloadPreparedBackup(context, filename, downloader){
    if (!context || context.state!=="READY" || !context.backupReceipt) throw new Error("Verified backup is required");
    (downloader || backup.downloadBackup)(context.backupPayload, filename || "booktokki-conflict-local-backup.json");
    context.backupDownloaded=true;
    return context;
  }

  async function resolve(options){
    var context=options.context;
    if (context && context.destructiveAttempted) throw new Error("Conflict replacement is locked for this session");
    if (!context || context.state!=="READY" || !context.backupDownloaded || !context.backupReceipt){
      throw new Error("Downloaded verified backup is required");
    }
    context.destructiveAttempted=true;
    var cloudNow=await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
    if (backup.baselineHash(cloudNow)!==context.baselineCloudHash) throw new Error("Cloud baseline changed");
    var validation=await cloudRestore.validateCloudRestoreSnapshot(cloudNow, options.userId);
    if (!validation.valid || cloudNow.books.length===0) throw new Error("Cloud snapshot is no longer valid");
    await replaceStores(options.database, validation.reconstructed.books, null);
    var localAfter=await dryRun.readLocalMigrationSnapshot(options.database);
    var localComparable=bootstrap.canonicalizeComparisonTimestamps(
      adapter.normalizeLocalSnapshot(bootstrap.comparableLocalSnapshot(localAfter), options.userId)
    );
    var cloudComparable=bootstrap.canonicalizeComparisonTimestamps(validation.normalized);
    var localManifest=await adapter.createMigrationManifest(localComparable);
    var cloudManifest=await adapter.createMigrationManifest(cloudComparable);
    if (localManifest.normalizedContentHash!==cloudManifest.normalizedContentHash) throw new Error("Local and Cloud hashes differ after replacement");
    var finalBootstrap=await bootstrap.runSafeCloudBootstrap({
      client:options.client, database:options.database, storage:options.storage, userId:options.userId
    });
    if (!finalBootstrap || finalBootstrap.state!==bootstrap.STATES.SYNCED || finalBootstrap.canStart!==true){
      throw new Error("Bootstrap did not reach SYNCED");
    }
    context.state="COMPLETE";
    return { success:true, cloudUnchanged:true, localWrites:validation.reconstructed.books.length, bootstrap:finalBootstrap };
  }

  return { prepare:prepare, downloadPreparedBackup:downloadPreparedBackup, resolve:resolve,
    restoreBackup:restoreBackup, replaceStores:replaceStores };
});
