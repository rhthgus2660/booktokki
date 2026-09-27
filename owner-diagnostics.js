(function(root, factory){
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var api = factory(
    isNode ? require("./supabase/migration-adapter.js") : root.BooktokkiMigrationAdapter,
    isNode ? require("./supabase/migration-dry-run.js") : root.BooktokkiMigrationDryRun,
    isNode ? require("./supabase/cloud-restore.js") : root.BooktokkiCloudRestore,
    isNode ? require("./supabase/cloud-bootstrap.js") : root.BooktokkiCloudBootstrap
  );
  if (isNode) module.exports = api;
  else root.BooktokkiOwnerDiagnostics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter, dryRun, cloudRestore, bootstrap){
  "use strict";

  if (!adapter || !dryRun || !cloudRestore || !bootstrap){
    throw new Error("Booktokki owner diagnostic dependencies are required");
  }

  var STATES = Object.freeze({
    SAFE_TO_ADOPT:"SAFE_TO_ADOPT",
    CONFLICT:"CONFLICT",
    UNVERIFIED:"UNVERIFIED"
  });

  function stable(value){
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object"){
      var output = {};
      Object.keys(value).sort().forEach(function(key){ output[key] = stable(value[key]); });
      return output;
    }
    return value;
  }

  function same(left, right){
    return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  }

  function indexByClientId(rows){
    return rows.reduce(function(index, row){ index[row.client_id] = row; return index; }, {});
  }

  function compareRows(cloudRows, localRows){
    var localById = indexByClientId(localRows);
    var matched = 0;
    var conflicts = 0;
    var missing = 0;
    cloudRows.forEach(function(cloudRow){
      var localRow = localById[cloudRow.client_id];
      if (!localRow){ missing++; return; }
      if (same(localRow, cloudRow)) matched++;
      else conflicts++;
    });
    return { matched:matched, conflicts:conflicts, missing:missing };
  }

  async function compareSnapshots(options){
    var localSnapshot = options.localSnapshot;
    var cloudSnapshot = options.cloudSnapshot;
    var userId = options.userId;
    var emptyResult = {
      state:STATES.UNVERIFIED,
      matchedBooks:0,
      cloudBooks:Array.isArray(cloudSnapshot && cloudSnapshot.books) ? cloudSnapshot.books.length : 0,
      matchedReadingLogs:0,
      cloudReadingLogs:Array.isArray(cloudSnapshot && cloudSnapshot.readingLogs) ? cloudSnapshot.readingLogs.length : 0,
      matchedBookNotes:0,
      cloudBookNotes:Array.isArray(cloudSnapshot && cloudSnapshot.bookNotes) ? cloudSnapshot.bookNotes.length : 0,
      localOnlyBooks:0,
      conflicts:0
    };

    if (options.ownerState !== "MISSING") return emptyResult;

    try {
      var cloudValidation = await cloudRestore.validateCloudRestoreSnapshot(cloudSnapshot, userId);
      if (!cloudValidation.valid) return emptyResult;

      var comparableLocal = bootstrap.comparableLocalSnapshot(localSnapshot);
      var localNormalized = bootstrap.canonicalizeComparisonTimestamps(
        adapter.normalizeLocalSnapshot(comparableLocal, userId)
      );
      var cloudNormalized = bootstrap.canonicalizeComparisonTimestamps(cloudValidation.normalized);
      var localBookIds = indexByClientId(localNormalized.books);
      var cloudBookIds = indexByClientId(cloudNormalized.books);
      var books = compareRows(cloudNormalized.books, localNormalized.books);
      var logs = compareRows(cloudNormalized.readingLogs, localNormalized.readingLogs);
      var notes = compareRows(cloudNormalized.bookNotes, localNormalized.bookNotes);
      var localOnlyBooks = Object.keys(localBookIds).filter(function(clientId){ return !cloudBookIds[clientId]; }).length;
      var conflictCount = books.conflicts + logs.conflicts + notes.conflicts;
      var missingCount = books.missing + logs.missing + notes.missing;
      var allCloudRowsMatch = cloudNormalized.books.length > 0
        && books.matched === cloudNormalized.books.length
        && logs.matched === cloudNormalized.readingLogs.length
        && notes.matched === cloudNormalized.bookNotes.length
        && conflictCount === 0
        && missingCount === 0;

      return {
        state:allCloudRowsMatch ? STATES.SAFE_TO_ADOPT : (conflictCount > 0 ? STATES.CONFLICT : STATES.UNVERIFIED),
        matchedBooks:books.matched,
        cloudBooks:cloudNormalized.books.length,
        matchedReadingLogs:logs.matched,
        cloudReadingLogs:cloudNormalized.readingLogs.length,
        matchedBookNotes:notes.matched,
        cloudBookNotes:cloudNormalized.bookNotes.length,
        localOnlyBooks:localOnlyBooks,
        conflicts:conflictCount
      };
    } catch (_error){
      return emptyResult;
    }
  }

  async function runReadOnlyComparison(options){
    var snapshots = await Promise.all([
      dryRun.readLocalMigrationSnapshot(options.database),
      dryRun.readCloudMigrationSnapshot(options.client, options.userId)
    ]);
    return compareSnapshots({
      localSnapshot:snapshots[0],
      cloudSnapshot:snapshots[1],
      userId:options.userId,
      ownerState:options.ownerState
    });
  }

  return {
    STATES:STATES,
    compareSnapshots:compareSnapshots,
    runReadOnlyComparison:runReadOnlyComparison
  };
});
