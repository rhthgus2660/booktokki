(function(root, factory){
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var api = factory(
    isNode ? require("./migration-adapter.js") : root.BooktokkiMigrationAdapter,
    isNode ? require("./migration-dry-run.js") : root.BooktokkiMigrationDryRun
  );
  if (isNode) module.exports = api;
  else root.BooktokkiCloudRestore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter, dryRun){
  "use strict";

  if (!adapter || !dryRun) throw new Error("Booktokki migration adapter and dry-run helpers are required");

  var STATES = Object.freeze({
    EMPTY:"EMPTY",
    LOCAL_ONLY:"LOCAL_ONLY",
    CLOUD_ONLY:"CLOUD_ONLY",
    CONFLICT:"CONFLICT",
    INVALID_CLOUD_STATE:"INVALID_CLOUD_STATE"
  });

  function clone(value){ return structuredClone(value); }
  function stable(value){
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object"){
      var output = {};
      Object.keys(value).sort().forEach(function(key){ output[key] = stable(value[key]); });
      return output;
    }
    return value;
  }
  function same(left, right){ return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
  function countsFromLocal(snapshot){
    var result = { books:snapshot.books.length, readingLogs:0, bookNotes:0, images:snapshot.images.length };
    snapshot.books.forEach(function(book){
      result.readingLogs += Array.isArray(book.pageLogs) ? book.pageLogs.length : 0;
      result.bookNotes += Array.isArray(book.notes) ? book.notes.length : 0;
    });
    return result;
  }
  function countsFromCloud(snapshot){
    return { books:snapshot.books.length, readingLogs:snapshot.readingLogs.length, bookNotes:snapshot.bookNotes.length };
  }
  function validationFailure(message, path){
    return { valid:false, error:{ name:"CloudRestoreValidationError", path:path || null, message:message } };
  }

  async function validateCloudRestoreSnapshot(cloudSnapshot, userId){
    var structure = dryRun.validateCloudStructure(cloudSnapshot, userId);
    if (!structure.valid) return validationFailure(structure.reason);
    for (var i = 0; i < cloudSnapshot.books.length; i++){
      var row = cloudSnapshot.books[i];
      if (!Number.isInteger(row.revision) || row.revision < 1) return validationFailure("book revision must be a positive integer", "books[" + i + "].revision");
      var reflectionValues = [
        row.completion_reflection_text,
        row.completion_reflection_created_at,
        row.completion_reflection_updated_at
      ];
      var reflectionPresent = reflectionValues.filter(function(value){ return value != null; }).length;
      if (reflectionPresent !== 0 && reflectionPresent !== 3){
        return validationFailure("completion reflection fields must be all present or all null", "books[" + i + "].completion_reflection");
      }
    }
    try {
      var reconstructed = adapter.reconstructLocalSnapshot(
        cloudSnapshot.books,
        cloudSnapshot.readingLogs,
        cloudSnapshot.bookNotes
      );
      var normalized = adapter.normalizeLocalSnapshot({ books:reconstructed.books, images:[] }, userId);
      var manifest = await adapter.createMigrationManifest(normalized);
      return { valid:true, reconstructed:reconstructed, normalized:normalized, manifest:manifest, error:null };
    } catch (error){
      return validationFailure(error.message, error.path || null);
    }
  }

  async function prepareCloudRestore(options){
    var localSnapshot = options.localSnapshot || await dryRun.readLocalMigrationSnapshot(options.database);
    var cloudSnapshot = options.cloudSnapshot || await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
    var local = countsFromLocal(localSnapshot);
    var cloud = countsFromCloud(cloudSnapshot);
    var validation = await validateCloudRestoreSnapshot(cloudSnapshot, options.userId);
    var state;
    if (!validation.valid) state = STATES.INVALID_CLOUD_STATE;
    else if (local.books === 0 && cloud.books === 0) state = STATES.EMPTY;
    else if (local.books === 0 && cloud.books > 0) state = STATES.CLOUD_ONLY;
    else if (local.books > 0 && cloud.books === 0) state = STATES.LOCAL_ONLY;
    else state = STATES.CONFLICT;
    return {
      state:state,
      canRestore:state === STATES.CLOUD_ONLY && validation.valid,
      localSnapshot:localSnapshot,
      cloudSnapshot:cloudSnapshot,
      local:local,
      cloud:cloud,
      validation:{ passed:validation.valid, errors:validation.valid ? [] : [validation.error] },
      reconstructed:validation.valid ? validation.reconstructed : null,
      normalized:validation.valid ? validation.normalized : null,
      manifest:validation.valid ? validation.manifest : null
    };
  }

  function transactionRequest(request){
    return new Promise(function(resolve, reject){
      request.onsuccess = function(){ resolve(request.result); };
      request.onerror = function(){ reject(request.error || new Error("IndexedDB request failed")); };
    });
  }
  function writeRestoredBooks(database, books){
    return new Promise(function(resolve, reject){
      var tx;
      var settled = false;
      function fail(error){
        if (settled) return;
        settled = true;
        reject(error || new Error("IndexedDB restore transaction failed"));
      }
      try { tx = database.transaction(["books"], "readwrite"); }
      catch (error){ fail(error); return; }
      tx.oncomplete = function(){
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onabort = function(){ fail(tx.error || new Error("IndexedDB restore transaction aborted")); };
      tx.onerror = function(){ /* onabort reports the final transaction error */ };
      try {
        var store = tx.objectStore("books");
        books.forEach(function(book){ store.put(clone(book)); });
        var verify = store.getAll();
        verify.onsuccess = function(){
          var actual = (verify.result || []).slice().sort(function(a, b){ return a.id.localeCompare(b.id); });
          var expected = books.map(clone).sort(function(a, b){ return a.id.localeCompare(b.id); });
          if (!same(actual, expected)){
            try { tx.abort(); } catch (_error) { fail(new Error("IndexedDB restore verification failed")); }
          }
        };
        verify.onerror = function(){
          try { tx.abort(); } catch (_error) { fail(verify.error || new Error("IndexedDB restore verification read failed")); }
        };
      } catch (error){
        try { tx.abort(); } catch (_abortError) { /* fail below */ }
        fail(error);
      }
    });
  }

  function unavailableAssets(options, cloudBooks){
    var journal = options.journal || null;
    var journalCovers = journal && Array.isArray(journal.excludedBlobCovers)
      ? clone(journal.excludedBlobCovers)
      : [];
    return {
      blobCovers:journalCovers,
      discoverableFromCloud:journalCovers.length > 0,
      coverlessCloudBooks:cloudBooks.filter(function(book){ return !book.cover_source_url; }).map(function(book){ return book.client_id; })
    };
  }

  async function executeCloudRestore(options){
    var prepared;
    var localWriteCompleted = false;
    try {
      prepared = await prepareCloudRestore(options);
      if (!prepared.canRestore){
        return {
          success:false,
          blocked:true,
          stateBefore:prepared.state,
          before:{
            localBooks:prepared.local.books,
            cloudBooks:prepared.cloud.books,
            cloudReadingLogs:prepared.cloud.readingLogs,
            cloudBookNotes:prepared.cloud.bookNotes
          },
          restored:{ books:0, readingLogs:0, bookNotes:0 },
          excludedUnavailableAssets:unavailableAssets(options, prepared.cloudSnapshot.books),
          verificationPassed:false,
          cloudUnchanged:true,
          localWriteCompleted:false,
          localWrites:0,
          validation:prepared.validation
        };
      }

      await writeRestoredBooks(options.database, prepared.reconstructed.books);
      localWriteCompleted = true;

      var localAfter = await dryRun.readLocalMigrationSnapshot(options.database);
      var normalizedAfter = adapter.normalizeLocalSnapshot(localAfter, options.userId);
      var manifestAfter = await adapter.createMigrationManifest(normalizedAfter);
      var localVerified = manifestAfter.normalizedContentHash === prepared.manifest.normalizedContentHash
        && manifestAfter.counts.books === prepared.manifest.counts.books
        && manifestAfter.counts.readingLogs === prepared.manifest.counts.readingLogs
        && manifestAfter.counts.bookNotes === prepared.manifest.counts.bookNotes;

      var cloudAfter = await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
      var cloudValidationAfter = await validateCloudRestoreSnapshot(cloudAfter, options.userId);
      var cloudUnchanged = cloudValidationAfter.valid
        && cloudValidationAfter.manifest.normalizedContentHash === prepared.manifest.normalizedContentHash;
      var verificationPassed = localVerified && cloudUnchanged;

      return {
        success:verificationPassed,
        blocked:false,
        stateBefore:prepared.state,
        before:{
          localBooks:prepared.local.books,
          cloudBooks:prepared.cloud.books,
          cloudReadingLogs:prepared.cloud.readingLogs,
          cloudBookNotes:prepared.cloud.bookNotes
        },
        restored:{
          books:manifestAfter.counts.books,
          readingLogs:manifestAfter.counts.readingLogs,
          bookNotes:manifestAfter.counts.bookNotes
        },
        excludedUnavailableAssets:unavailableAssets(options, prepared.cloudSnapshot.books),
        verificationPassed:verificationPassed,
        cloudUnchanged:cloudUnchanged,
        localWriteCompleted:localWriteCompleted,
        localWrites:prepared.reconstructed.books.length,
        validation:prepared.validation
      };
    } catch (error){
      return {
        success:false,
        blocked:false,
        stateBefore:prepared ? prepared.state : null,
        error:{ name:error.name || "Error", message:error.message || "Cloud restore failed" },
        restored:{ books:0, readingLogs:0, bookNotes:0 },
        verificationPassed:false,
        cloudUnchanged:true,
        localWriteCompleted:localWriteCompleted,
        localWrites:localWriteCompleted && prepared ? prepared.reconstructed.books.length : 0
      };
    }
  }

  return {
    STATES:STATES,
    validateCloudRestoreSnapshot:validateCloudRestoreSnapshot,
    prepareCloudRestore:prepareCloudRestore,
    writeRestoredBooks:writeRestoredBooks,
    executeCloudRestore:executeCloudRestore
  };
});
