(function(root, factory){
  "use strict";
  var api = factory(
    typeof module === "object" && module.exports
      ? require("./migration-adapter.js")
      : root.BooktokkiMigrationAdapter
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BooktokkiMigrationDryRun = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter){
  "use strict";

  if (!adapter) throw new Error("BooktokkiMigrationAdapter is required");

  var STATES = Object.freeze({
    EMPTY: "EMPTY",
    LOCAL_ONLY: "LOCAL_ONLY",
    CLOUD_ONLY: "CLOUD_ONLY",
    CONFLICT: "CONFLICT",
    INVALID_CLOUD_STATE: "INVALID_CLOUD_STATE",
    RESUMABLE_MIGRATION: "RESUMABLE_MIGRATION",
    VALIDATION_FAILED: "VALIDATION_FAILED"
  });
  var JOURNAL_VERSION = 1;

  function isObject(value){ return value !== null && typeof value === "object" && !Array.isArray(value); }
  function clone(value){ return JSON.parse(JSON.stringify(value)); }
  function requiredString(value, label){
    if (typeof value !== "string" || value.trim() === "") throw new Error(label + " must be a non-empty string");
    return value;
  }
  function timestamp(value, label, nullable){
    if (nullable && value == null) return null;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(label + " must be a timestamp");
    return value;
  }
  function counts(value, label){
    if (!isObject(value)) throw new Error(label + " must be an object");
    ["books", "readingLogs", "bookNotes"].forEach(function(key){
      if (!Number.isInteger(value[key]) || value[key] < 0) throw new Error(label + "." + key + " must be a nonnegative integer");
    });
    return { books:value.books, readingLogs:value.readingLogs, bookNotes:value.bookNotes };
  }
  function migrationJournalKey(userId){
    return "booktokki:migration:v1:" + requiredString(userId, "userId");
  }
  function validateMigrationJournal(journal, expectedUserId){
    if (!isObject(journal)) throw new Error("migration journal must be an object");
    if (journal.version !== JOURNAL_VERSION) throw new Error("unsupported migration journal version");
    if (journal.userId !== expectedUserId) throw new Error("migration journal user mismatch");
    if (journal.status !== "in_progress" && journal.status !== "complete") throw new Error("invalid migration journal status");
    requiredString(journal.manifestHash, "journal.manifestHash");
    timestamp(journal.startedAt, "journal.startedAt", false);
    timestamp(journal.updatedAt, "journal.updatedAt", false);
    timestamp(journal.completedAt, "journal.completedAt", true);
    if (journal.status === "in_progress" && journal.completedAt != null) throw new Error("in-progress journal cannot be completed");
    if (journal.status === "complete" && journal.completedAt == null) throw new Error("complete journal requires completedAt");
    counts(journal.counts, "journal.counts");
    if (!Array.isArray(journal.excludedBlobCovers)) throw new Error("journal.excludedBlobCovers must be an array");
    return clone(journal);
  }
  function createMigrationJournal(manifest, status, times){
    status = status || "in_progress";
    times = times || {};
    var journal = {
      version: JOURNAL_VERSION,
      userId: manifest.userId,
      status: status,
      manifestHash: manifest.normalizedContentHash,
      startedAt: times.startedAt,
      updatedAt: times.updatedAt,
      completedAt: status === "complete" ? times.completedAt : null,
      counts: clone(manifest.counts),
      excludedBlobCovers: clone(manifest.excludedBlobCovers)
    };
    return validateMigrationJournal(journal, manifest.userId);
  }
  function readMigrationJournal(storage, userId){
    if (!storage || typeof storage.getItem !== "function") throw new Error("readable storage is required");
    var raw = storage.getItem(migrationJournalKey(userId));
    if (raw == null) return null;
    return validateMigrationJournal(JSON.parse(raw), userId);
  }

  function requestResult(request){
    return new Promise(function(resolve, reject){
      request.onsuccess = function(){ resolve(request.result); };
      request.onerror = function(){ reject(request.error || new Error("IndexedDB read failed")); };
    });
  }
  function readLocalMigrationSnapshot(database){
    if (!database || typeof database.transaction !== "function") return Promise.reject(new Error("open IndexedDB database is required"));
    return new Promise(function(resolve, reject){
      var tx;
      try { tx = database.transaction(["books", "images"], "readonly"); }
      catch (error){ reject(error); return; }
      var booksRequest, imagesRequest;
      try {
        booksRequest = tx.objectStore("books").getAll();
        imagesRequest = tx.objectStore("images").getAll();
      } catch (error){ reject(error); return; }
      Promise.all([requestResult(booksRequest), requestResult(imagesRequest)]).then(function(results){
        resolve({ books:results[0], images:results[1] });
      }, reject);
      tx.onabort = function(){ reject(tx.error || new Error("IndexedDB readonly transaction aborted")); };
      tx.onerror = function(){ reject(tx.error || new Error("IndexedDB readonly transaction failed")); };
    });
  }
  function openExistingLocalDatabase(indexedDBFactory){
    if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") return Promise.reject(new Error("IndexedDB is unavailable"));
    var inventory = typeof indexedDBFactory.databases === "function"
      ? indexedDBFactory.databases()
      : Promise.resolve(null);
    return inventory.then(function(databases){
      if (databases && !databases.some(function(item){ return item.name === "booktokki"; })) return null;
      return new Promise(function(resolve, reject){
        var request = indexedDBFactory.open("booktokki");
        request.onupgradeneeded = function(){ request.transaction.abort(); };
        request.onsuccess = function(){ resolve(request.result); };
        request.onerror = function(){
          if (request.error && request.error.name === "AbortError") resolve(null);
          else reject(request.error || new Error("IndexedDB open failed"));
        };
        request.onblocked = function(){ reject(new Error("IndexedDB open was blocked")); };
      });
    });
  }

  function cloudQuery(client, table, userId, orderColumn){
    return client.from(table).select("*").eq("user_id", userId).order(orderColumn, { ascending:true });
  }
  function rowsOrThrow(result, table){
    if (result.error) throw result.error;
    if (!Array.isArray(result.data)) throw new Error(table + " SELECT did not return rows");
    return result.data;
  }
  function readCloudMigrationSnapshot(client, userId){
    if (!client || typeof client.from !== "function") return Promise.reject(new Error("authenticated Supabase client is required"));
    requiredString(userId, "userId");
    return Promise.all([
      cloudQuery(client, "books", userId, "created_at"),
      cloudQuery(client, "reading_logs", userId, "recorded_at"),
      cloudQuery(client, "book_notes", userId, "created_at")
    ]).then(function(results){
      return {
        books:rowsOrThrow(results[0], "books"),
        readingLogs:rowsOrThrow(results[1], "reading_logs"),
        bookNotes:rowsOrThrow(results[2], "book_notes")
      };
    });
  }

  function canonicalTimestamp(value){
    return value == null ? null : new Date(value).toISOString();
  }
  function canonical(value){
    if (Array.isArray(value)) return value.map(canonical);
    if (isObject(value)){
      var output = {};
      Object.keys(value).sort().forEach(function(key){ output[key] = canonical(value[key]); });
      return output;
    }
    return value;
  }
  function same(left, right){ return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
  function projectBook(row){
    return {
      user_id:row.user_id,
      client_id:row.client_id,
      title:row.title,
      author:row.author,
      total_pages:row.total_pages,
      current_page:row.current_page,
      status:row.status,
      isbn13:row.isbn13 == null ? null : row.isbn13,
      publisher:row.publisher == null ? null : row.publisher,
      published_on:row.published_on == null ? null : row.published_on,
      source_provider:row.source_provider == null ? null : row.source_provider,
      source_id:row.source_id == null ? null : row.source_id,
      cover_source_url:row.cover_source_url == null ? null : row.cover_source_url,
      last_page_log_date:row.last_page_log_date == null ? null : row.last_page_log_date,
      day_start_page:row.day_start_page == null ? null : row.day_start_page,
      completed_at:canonicalTimestamp(row.completed_at),
      completion_reflection_text:row.completion_reflection_text == null ? null : row.completion_reflection_text,
      completion_reflection_created_at:canonicalTimestamp(row.completion_reflection_created_at),
      completion_reflection_updated_at:canonicalTimestamp(row.completion_reflection_updated_at),
      created_at:canonicalTimestamp(row.created_at),
      updated_at:canonicalTimestamp(row.updated_at)
    };
  }
  function projectExpectedBook(row){
    var projected = Object.assign({}, row);
    ["completed_at", "completion_reflection_created_at", "completion_reflection_updated_at", "created_at", "updated_at"].forEach(function(key){
      projected[key] = canonicalTimestamp(projected[key]);
    });
    return projected;
  }
  function projectLog(row, bookClientId){
    return {
      user_id:row.user_id,
      client_id:row.client_id,
      log_date:row.log_date,
      previous_page:row.previous_page,
      current_page:row.current_page,
      delta:row.delta,
      recorded_at:canonicalTimestamp(row.recorded_at),
      _book_client_id:bookClientId
    };
  }
  function projectNote(row, bookClientId){
    return {
      user_id:row.user_id,
      client_id:row.client_id,
      text:row.text,
      page:row.page == null ? null : row.page,
      created_at:canonicalTimestamp(row.created_at),
      updated_at:canonicalTimestamp(row.updated_at),
      _book_client_id:bookClientId
    };
  }
  function normalizedExpectedChild(row, timestampKeys){
    var projected = Object.assign({}, row);
    delete projected.book_id;
    timestampKeys.forEach(function(key){ projected[key] = canonicalTimestamp(projected[key]); });
    return projected;
  }

  function validateCloudStructure(cloud, userId){
    if (!cloud || !Array.isArray(cloud.books) || !Array.isArray(cloud.readingLogs) || !Array.isArray(cloud.bookNotes)){
      return { valid:false, reason:"cloud snapshot arrays are required" };
    }
    var cloudIds = {}, clientIds = {};
    for (var i = 0; i < cloud.books.length; i++){
      var book = cloud.books[i];
      if (!book || !book.id || !book.client_id || book.user_id !== userId || cloudIds[book.id] || clientIds[book.client_id]){
        return { valid:false, reason:"invalid or duplicate cloud book" };
      }
      cloudIds[book.id] = book.client_id;
      clientIds[book.client_id] = true;
    }
    var seenLogs = {};
    for (var j = 0; j < cloud.readingLogs.length; j++){
      var log = cloud.readingLogs[j];
      if (!log || log.user_id !== userId || !cloudIds[log.book_id] || !log.client_id || seenLogs[log.client_id]){
        return { valid:false, reason:"invalid reading log parent or client ID" };
      }
      seenLogs[log.client_id] = true;
    }
    var seenNotes = {};
    for (var k = 0; k < cloud.bookNotes.length; k++){
      var note = cloud.bookNotes[k];
      if (!note || note.user_id !== userId || !cloudIds[note.book_id] || !note.client_id || seenNotes[note.client_id]){
        return { valid:false, reason:"invalid book note parent or client ID" };
      }
      seenNotes[note.client_id] = true;
    }
    return { valid:true, cloudBookClientIdById:cloudIds };
  }

  function resumableRowsMatch(normalized, manifest, cloud, structure){
    var expectedBooks = {}, expectedLogs = {}, expectedNotes = {};
    normalized.books.forEach(function(row){ expectedBooks[row.client_id] = projectExpectedBook(row); });
    normalized.readingLogs.forEach(function(row){ expectedLogs[row.client_id] = normalizedExpectedChild(row, ["recorded_at"]); });
    normalized.bookNotes.forEach(function(row){ expectedNotes[row.client_id] = normalizedExpectedChild(row, ["created_at", "updated_at"]); });

    if (cloud.books.some(function(row){
      return row.revision !== 1
        || manifest.bookClientIds.indexOf(row.client_id) === -1
        || !same(projectBook(row), expectedBooks[row.client_id]);
    })) return false;
    if (cloud.readingLogs.some(function(row){
      var parent = structure.cloudBookClientIdById[row.book_id];
      return manifest.readingLogClientIds.indexOf(row.client_id) === -1 || !same(projectLog(row, parent), expectedLogs[row.client_id]);
    })) return false;
    if (cloud.bookNotes.some(function(row){
      var parent = structure.cloudBookClientIdById[row.book_id];
      return manifest.noteClientIds.indexOf(row.client_id) === -1 || !same(projectNote(row, parent), expectedNotes[row.client_id]);
    })) return false;
    return true;
  }

  function detectMigrationState(input){
    var localBookCount = input.localBookCount;
    var cloud = input.cloudSnapshot;
    var normalized = input.normalized;
    var manifest = input.manifest;
    var journal = input.journal;
    var cloudCount = cloud.books.length + cloud.readingLogs.length + cloud.bookNotes.length;

    if (cloud.books.length === 0 && (cloud.readingLogs.length > 0 || cloud.bookNotes.length > 0)) return STATES.INVALID_CLOUD_STATE;
    var structure = validateCloudStructure(cloud, manifest.userId);
    if (!structure.valid) return STATES.INVALID_CLOUD_STATE;
    if (localBookCount === 0 && cloudCount === 0) return STATES.EMPTY;
    if (localBookCount === 0 && cloud.books.length > 0) return STATES.CLOUD_ONLY;
    if (localBookCount > 0 && cloudCount === 0) return STATES.LOCAL_ONLY;

    if (journal && journal.status === "in_progress"
        && journal.userId === manifest.userId
        && journal.manifestHash === manifest.normalizedContentHash
        && same(journal.counts, manifest.counts)
        && resumableRowsMatch(normalized, manifest, cloud, structure)){
      return STATES.RESUMABLE_MIGRATION;
    }
    return STATES.CONFLICT;
  }

  function emptyCounts(){ return { books:0, readingLogs:0, bookNotes:0 }; }
  async function buildMigrationDryRunReport(input){
    var localSnapshot = input.localSnapshot;
    var cloudSnapshot = input.cloudSnapshot;
    var userId = input.userId;
    var localCounts = {
      books:Array.isArray(localSnapshot.books) ? localSnapshot.books.length : 0,
      readingLogs:0,
      bookNotes:0,
      images:Array.isArray(localSnapshot.images) ? localSnapshot.images.length : 0
    };
    if (Array.isArray(localSnapshot.books)) localSnapshot.books.forEach(function(book){
      localCounts.readingLogs += Array.isArray(book.pageLogs) ? book.pageLogs.length : 0;
      localCounts.bookNotes += Array.isArray(book.notes) ? book.notes.length : 0;
    });
    var cloudCounts = {
      books:cloudSnapshot.books.length,
      readingLogs:cloudSnapshot.readingLogs.length,
      bookNotes:cloudSnapshot.bookNotes.length
    };
    try {
      var normalized = adapter.normalizeLocalSnapshot(localSnapshot, userId);
      var manifest = await adapter.createMigrationManifest(normalized);
      var state = detectMigrationState({
        localBookCount:localCounts.books,
        cloudSnapshot:cloudSnapshot,
        normalized:normalized,
        manifest:manifest,
        journal:input.journal || null
      });
      var canMigrate = state === STATES.LOCAL_ONLY;
      return {
        state:state,
        canMigrate:canMigrate,
        local:localCounts,
        cloudBefore:cloudCounts,
        wouldCreate:canMigrate ? clone(manifest.counts) : emptyCounts(),
        excluded:{
          blobCovers:clone(normalized.excludedBlobCovers),
          orphanImageIds:clone(normalized.orphanImageIds)
        },
        manifestHash:manifest.normalizedContentHash,
        validation:{ passed:true, errors:[] }
      };
    } catch (error){
      return {
        state:STATES.VALIDATION_FAILED,
        canMigrate:false,
        local:localCounts,
        cloudBefore:cloudCounts,
        wouldCreate:emptyCounts(),
        excluded:{ blobCovers:[], orphanImageIds:[] },
        manifestHash:null,
        validation:{ passed:false, errors:[{ name:error.name, path:error.path || null, message:error.message }] }
      };
    }
  }

  return {
    STATES:STATES,
    JOURNAL_VERSION:JOURNAL_VERSION,
    migrationJournalKey:migrationJournalKey,
    validateMigrationJournal:validateMigrationJournal,
    createMigrationJournal:createMigrationJournal,
    readMigrationJournal:readMigrationJournal,
    openExistingLocalDatabase:openExistingLocalDatabase,
    readLocalMigrationSnapshot:readLocalMigrationSnapshot,
    readCloudMigrationSnapshot:readCloudMigrationSnapshot,
    validateCloudStructure:validateCloudStructure,
    detectMigrationState:detectMigrationState,
    buildMigrationDryRunReport:buildMigrationDryRunReport
  };
});
