(function(root, factory){
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var api = factory(
    isNode ? require("./migration-adapter.js") : root.BooktokkiMigrationAdapter,
    isNode ? require("./migration-dry-run.js") : root.BooktokkiMigrationDryRun
  );
  if (isNode) module.exports = api;
  else root.BooktokkiMigrationExecutor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter, dryRun){
  "use strict";

  if (!adapter || !dryRun) throw new Error("Booktokki migration adapter and dry-run helpers are required");

  function clone(value){ return JSON.parse(JSON.stringify(value)); }
  function nowIso(options){ return options && options.now ? options.now() : new Date().toISOString(); }
  function safeError(error){
    return {
      name:error && error.name ? String(error.name) : "Error",
      code:error && error.code ? String(error.code) : null,
      status:error && Number.isFinite(error.status) ? error.status : null,
      message:error && error.message ? String(error.message) : "Migration failed"
    };
  }
  function writeMigrationJournal(storage, journal){
    if (!storage || typeof storage.setItem !== "function") throw new Error("writable journal storage is required");
    var validated = dryRun.validateMigrationJournal(journal, journal.userId);
    storage.setItem(dryRun.migrationJournalKey(journal.userId), JSON.stringify(validated));
    return validated;
  }
  function inProgressJournal(manifest, previous, at){
    return dryRun.createMigrationJournal(manifest, "in_progress", {
      startedAt:previous && previous.startedAt ? previous.startedAt : at,
      updatedAt:at
    });
  }
  function completeJournal(manifest, previous, at){
    return dryRun.createMigrationJournal(manifest, "complete", {
      startedAt:previous.startedAt,
      updatedAt:at,
      completedAt:at
    });
  }
  function cloudCounts(cloud){
    return { books:cloud.books.length, readingLogs:cloud.readingLogs.length, bookNotes:cloud.bookNotes.length };
  }
  function remainingCounts(manifest, cloud){
    var count = cloudCounts(cloud);
    return {
      books:Math.max(0, manifest.counts.books - count.books),
      readingLogs:Math.max(0, manifest.counts.readingLogs - count.readingLogs),
      bookNotes:Math.max(0, manifest.counts.bookNotes - count.bookNotes)
    };
  }
  function bookRefs(cloud){
    var refs = {};
    cloud.books.forEach(function(row){
      refs[row.client_id] = { cloudId:row.id, revision:row.revision, userId:row.user_id };
    });
    return refs;
  }
  function ids(rows){
    var result = {};
    rows.forEach(function(row){ result[row.client_id] = true; });
    return result;
  }
  function throwResult(result){
    if (result.error) throw result.error;
    if (!result.data) throw new Error("Cloud insert returned no row");
    return result.data;
  }
  function insertOne(client, table, row){
    return client.from(table).insert(row).select("*").single().then(throwResult);
  }
  async function insertMissing(client, table, rows, existingRows, written, key){
    var existing = ids(existingRows);
    for (var i = 0; i < rows.length; i++){
      if (existing[rows[i].client_id]) continue;
      var inserted = await insertOne(client, table, rows[i]);
      existingRows.push(inserted);
      existing[rows[i].client_id] = true;
      written[key] += 1;
    }
  }

  async function prepareMigrationExecution(options){
    var cloud = await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
    var journal = dryRun.readMigrationJournal(options.storage, options.userId);
    var report = await dryRun.buildMigrationDryRunReport({
      localSnapshot:options.localSnapshot,
      cloudSnapshot:cloud,
      userId:options.userId,
      journal:journal
    });
    if (!report.validation.passed){
      return { report:report, cloudSnapshot:cloud, journal:journal, normalized:null, manifest:null };
    }
    var normalized = adapter.normalizeLocalSnapshot(options.localSnapshot, options.userId);
    var manifest = await adapter.createMigrationManifest(normalized);
    return { report:report, cloudSnapshot:cloud, journal:journal, normalized:normalized, manifest:manifest };
  }

  function resumableState(normalized, manifest, cloud, journal){
    return dryRun.detectMigrationState({
      localBookCount:normalized.books.length,
      cloudSnapshot:cloud,
      normalized:normalized,
      manifest:manifest,
      journal:journal
    });
  }
  function verificationJournal(manifest, journal){
    return Object.assign({}, journal, { status:"in_progress", completedAt:null });
  }
  function verifyCompleteSnapshot(normalized, manifest, cloud, journal){
    if (cloud.books.length !== manifest.counts.books
        || cloud.readingLogs.length !== manifest.counts.readingLogs
        || cloud.bookNotes.length !== manifest.counts.bookNotes){
      return { passed:false, reason:"Cloud row counts do not match the manifest" };
    }
    var state = resumableState(normalized, manifest, cloud, verificationJournal(manifest, journal));
    if (state !== dryRun.STATES.RESUMABLE_MIGRATION){
      return { passed:false, reason:"Cloud content or parent mapping does not match the normalized Local snapshot" };
    }
    try {
      var reconstructed = adapter.reconstructLocalSnapshot(cloud.books, cloud.readingLogs, cloud.bookNotes);
      if (reconstructed.books.length !== manifest.counts.books) return { passed:false, reason:"Cloud reconstruction count mismatch" };
    } catch (error){
      return { passed:false, reason:error.message };
    }
    return { passed:true, reason:null };
  }

  async function executeMigration(options){
    var prepared;
    var stage = "preflight";
    var written = { books:0, readingLogs:0, bookNotes:0 };
    var lastCloud = { books:[], readingLogs:[], bookNotes:[] };
    var activeJournal = null;
    var resumed = false;
    try {
      prepared = await prepareMigrationExecution(options);
      lastCloud = prepared.cloudSnapshot;
      var state = prepared.report.state;

      if (!prepared.report.validation.passed){
        return {
          success:false,
          blocked:true,
          stage:"preflight",
          state:state,
          error:{ name:"MigrationBlocked", code:null, status:null, message:"Local migration preflight validation failed" },
          manifestHash:null,
          written:written,
          remaining:null,
          verificationPassed:false,
          journalStatus:prepared.journal ? prepared.journal.status : null,
          localPreserved:true
        };
      }

      if (prepared.journal && prepared.journal.status === "complete"){
        var completeMatches = prepared.journal.manifestHash === prepared.manifest.normalizedContentHash
          && resumableState(
            prepared.normalized,
            prepared.manifest,
            prepared.cloudSnapshot,
            verificationJournal(prepared.manifest, prepared.journal)
          ) === dryRun.STATES.RESUMABLE_MIGRATION;
        var completeVerification = completeMatches
          ? verifyCompleteSnapshot(prepared.normalized, prepared.manifest, prepared.cloudSnapshot, prepared.journal)
          : { passed:false, reason:"Completed journal does not match current Local and Cloud data" };
        if (!completeVerification.passed) throw new Error(completeVerification.reason);
        return {
          success:true,
          alreadyComplete:true,
          resumed:true,
          manifestHash:prepared.manifest.normalizedContentHash,
          before:{ localBooks:prepared.report.local.books, cloudBooks:prepared.report.cloudBefore.books },
          written:written,
          remaining:{ books:0, readingLogs:0, bookNotes:0 },
          after:{
            cloudBooks:lastCloud.books.length,
            cloudReadingLogs:lastCloud.readingLogs.length,
            cloudBookNotes:lastCloud.bookNotes.length
          },
          verificationPassed:true,
          journalStatus:"complete",
          localPreserved:true,
          excludedBlobCovers:clone(prepared.manifest.excludedBlobCovers)
        };
      }

      if (state === dryRun.STATES.LOCAL_ONLY
          && prepared.report.canMigrate === true
          && prepared.report.validation.passed === true){
        resumed = false;
      } else if (state === dryRun.STATES.RESUMABLE_MIGRATION
          && prepared.journal && prepared.journal.status === "in_progress"){
        resumed = true;
      } else {
        return {
          success:false,
          blocked:true,
          stage:"preflight",
          state:state,
          error:{ name:"MigrationBlocked", code:null, status:null, message:"Migration state does not permit Cloud writes" },
          manifestHash:prepared.manifest.normalizedContentHash,
          written:written,
          remaining:remainingCounts(prepared.manifest, prepared.cloudSnapshot),
          verificationPassed:false,
          journalStatus:prepared.journal ? prepared.journal.status : null,
          localPreserved:true
        };
      }

      stage = "journal";
      activeJournal = inProgressJournal(prepared.manifest, prepared.journal, nowIso(options));
      writeMigrationJournal(options.storage, activeJournal);

      stage = "books";
      await insertMissing(options.client, "books", prepared.normalized.books, lastCloud.books, written, "books");
      lastCloud = await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
      if (resumableState(prepared.normalized, prepared.manifest, lastCloud, activeJournal) !== dryRun.STATES.RESUMABLE_MIGRATION){
        throw new Error("Cloud books do not match the migration manifest after insert");
      }
      activeJournal = inProgressJournal(prepared.manifest, activeJournal, nowIso(options));
      writeMigrationJournal(options.storage, activeJournal);

      var materialized = adapter.materializeCloudRows(prepared.normalized, bookRefs(lastCloud));

      stage = "reading_logs";
      await insertMissing(options.client, "reading_logs", materialized.readingLogs, lastCloud.readingLogs, written, "readingLogs");
      lastCloud = await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
      if (resumableState(prepared.normalized, prepared.manifest, lastCloud, activeJournal) !== dryRun.STATES.RESUMABLE_MIGRATION){
        throw new Error("Cloud reading logs do not match the migration manifest after insert");
      }
      activeJournal = inProgressJournal(prepared.manifest, activeJournal, nowIso(options));
      writeMigrationJournal(options.storage, activeJournal);

      stage = "book_notes";
      await insertMissing(options.client, "book_notes", materialized.bookNotes, lastCloud.bookNotes, written, "bookNotes");

      stage = "verification";
      lastCloud = await dryRun.readCloudMigrationSnapshot(options.client, options.userId);
      var verification = verifyCompleteSnapshot(prepared.normalized, prepared.manifest, lastCloud, activeJournal);
      if (!verification.passed) throw new Error(verification.reason);

      stage = "complete_journal";
      activeJournal = completeJournal(prepared.manifest, activeJournal, nowIso(options));
      writeMigrationJournal(options.storage, activeJournal);

      return {
        success:true,
        alreadyComplete:false,
        resumed:resumed,
        manifestHash:prepared.manifest.normalizedContentHash,
        before:{ localBooks:prepared.report.local.books, cloudBooks:prepared.report.cloudBefore.books },
        written:written,
        remaining:{ books:0, readingLogs:0, bookNotes:0 },
        after:{
          cloudBooks:lastCloud.books.length,
          cloudReadingLogs:lastCloud.readingLogs.length,
          cloudBookNotes:lastCloud.bookNotes.length
        },
        verificationPassed:true,
        journalStatus:"complete",
        localPreserved:true,
        excludedBlobCovers:clone(prepared.manifest.excludedBlobCovers)
      };
    } catch (error){
      return {
        success:false,
        blocked:false,
        stage:stage,
        error:safeError(error),
        manifestHash:prepared && prepared.manifest ? prepared.manifest.normalizedContentHash : null,
        written:written,
        remaining:prepared && prepared.manifest ? remainingCounts(prepared.manifest, lastCloud) : null,
        verificationPassed:false,
        journalStatus:activeJournal ? activeJournal.status : (prepared && prepared.journal ? prepared.journal.status : null),
        localPreserved:true
      };
    }
  }

  return {
    writeMigrationJournal:writeMigrationJournal,
    prepareMigrationExecution:prepareMigrationExecution,
    verifyCompleteSnapshot:verifyCompleteSnapshot,
    executeMigration:executeMigration
  };
});
