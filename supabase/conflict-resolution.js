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

  var RECOVERY_STORAGE_KEY = "booktokki:conflict-resolution:v2";
  var RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;

  function clone(value){ return structuredClone(value); }
  function same(left, right){ return JSON.stringify(left) === JSON.stringify(right); }
  function recoveryError(code, message){ var error=new Error(message); error.code=code; return error; }
  function recoveryStorage(options){
    if (!options || !options.recoveryStorage || typeof options.recoveryStorage.getItem!=="function"
        || typeof options.recoveryStorage.setItem!=="function" || typeof options.recoveryStorage.removeItem!=="function"){
      throw recoveryError("RECOVERY_STORAGE_UNAVAILABLE", "Conflict recovery storage is unavailable");
    }
    return options.recoveryStorage;
  }
  function receiptParts(receipt){
    try { return JSON.parse(receipt && receipt.payloadFingerprint || ""); }
    catch (_error){ return null; }
  }
  function proofFromContext(context, now){
    var parts=receiptParts(context && context.backupReceipt);
    if (!parts || parts.userId!==context.userId || parts.localManifestHash!==context.backupPayload.localManifestHash
        || parts.baselineCloudHash!==context.baselineCloudHash || parts.payloadHash!==context.backupPayload.payloadHash){
      throw recoveryError("RECOVERY_PROOF_INVALID", "Verified backup receipt is invalid");
    }
    return {version:2,status:"READY",userId:context.userId,createdAt:now == null ? Date.now() : now,
      localManifestHash:parts.localManifestHash,baselineCloudHash:parts.baselineCloudHash,
      payloadHash:parts.payloadHash,payloadFingerprint:context.backupReceipt.payloadFingerprint};
  }
  function validateProof(proof, userId, now){
    var at=now == null ? Date.now() : now, parts=receiptParts(proof);
    if (!proof || proof.version!==2 || proof.status!=="READY" || typeof proof.createdAt!=="number"
        || !proof.userId || typeof proof.localManifestHash!=="string" || typeof proof.baselineCloudHash!=="string"
        || typeof proof.payloadHash!=="string" || typeof proof.payloadFingerprint!=="string" || !parts
        || parts.userId!==proof.userId || parts.localManifestHash!==proof.localManifestHash
        || parts.baselineCloudHash!==proof.baselineCloudHash || parts.payloadHash!==proof.payloadHash){
      throw recoveryError("RECOVERY_CONTEXT_INVALID", "Saved conflict recovery context is invalid");
    }
    if (proof.userId!==userId) throw recoveryError("RECOVERY_USER_MISMATCH", "Saved conflict recovery belongs to another user");
    if (at<proof.createdAt || at-proof.createdAt>RECOVERY_MAX_AGE_MS){
      throw recoveryError("RECOVERY_CONTEXT_STALE", "Saved conflict recovery context has expired");
    }
    return proof;
  }
  function readProof(options){
    var store=recoveryStorage(options), raw=store.getItem(RECOVERY_STORAGE_KEY);
    if (raw==null) return null;
    var proof;
    try { proof=JSON.parse(raw); }
    catch (_error){ throw recoveryError("RECOVERY_CONTEXT_INVALID", "Saved conflict recovery context cannot be read"); }
    return validateProof(proof,options.userId,options.now);
  }
  function writeProof(options, proof){ recoveryStorage(options).setItem(RECOVERY_STORAGE_KEY,JSON.stringify(proof)); return proof; }
  function clearProof(options){ recoveryStorage(options).removeItem(RECOVERY_STORAGE_KEY); }
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

  function downloadPreparedBackup(context, filename, downloader, options){
    if (!context || context.state!=="READY" || !context.backupReceipt) throw new Error("Verified backup is required");
    var proof=proofFromContext(context,options&&options.now);
    writeProof(options,proof);
    try { (downloader || backup.downloadBackup)(context.backupPayload, filename || "booktokki-conflict-local-backup.json"); }
    catch (error){ clearProof(options); throw error; }
    context.backupDownloaded=true;
    context.recoveryProof=proof;
    return context;
  }

  async function recover(options){
    var proof=readProof(options);
    if (!proof) return null;
    var context=await prepare(options);
    if (context.userId!==proof.userId || context.backupPayload.localManifestHash!==proof.localManifestHash
        || context.baselineCloudHash!==proof.baselineCloudHash){
      throw recoveryError("RECOVERY_CONTEXT_CHANGED", "Current conflict no longer matches the saved backup context");
    }
    context.backupDownloaded=true;
    context.recoveryProof=proof;
    context.recovered=true;
    return context;
  }

  async function resolve(options){
    var context=options.context;
    if (context && context.destructiveAttempted) throw new Error("Conflict replacement is locked for this session");
    if (!context || context.state!=="READY" || !context.backupReceipt){
      throw new Error("Verified backup context is required");
    }
    var proof=readProof(options);
    if (!proof || !context.recoveryProof || proof.payloadFingerprint!==context.recoveryProof.payloadFingerprint
        || proof.userId!==context.userId || proof.localManifestHash!==context.backupPayload.localManifestHash
        || proof.baselineCloudHash!==context.baselineCloudHash){
      throw recoveryError("RECOVERY_PROOF_REQUIRED", "Verified conflict recovery proof is required");
    }
    context.destructiveAttempted=true;
    var attempted=Object.assign({},proof,{status:"ATTEMPTED"});
    writeProof(options,attempted);
    var current=await prepare(options);
    if (current.backupPayload.localManifestHash!==proof.localManifestHash || current.baselineCloudHash!==proof.baselineCloudHash){
      throw recoveryError("RECOVERY_CONTEXT_CHANGED", "Current conflict changed before replacement");
    }
    var cloudNow=await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
    if (backup.baselineHash(cloudNow)!==proof.baselineCloudHash) throw new Error("Cloud baseline changed");
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
    clearProof(options);
    return { success:true, cloudUnchanged:true, localWrites:validation.reconstructed.books.length, bootstrap:finalBootstrap };
  }

  return { prepare:prepare, downloadPreparedBackup:downloadPreparedBackup, recover:recover, resolve:resolve,
    restoreBackup:restoreBackup, replaceStores:replaceStores, RECOVERY_STORAGE_KEY:RECOVERY_STORAGE_KEY,
    RECOVERY_MAX_AGE_MS:RECOVERY_MAX_AGE_MS };
});
