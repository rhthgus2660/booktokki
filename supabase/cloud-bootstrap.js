(function(root, factory){
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var api = factory(
    isNode ? require("./migration-adapter.js") : root.BooktokkiMigrationAdapter,
    isNode ? require("./migration-dry-run.js") : root.BooktokkiMigrationDryRun,
    isNode ? require("./migration-executor.js") : root.BooktokkiMigrationExecutor,
    isNode ? require("./cloud-restore.js") : root.BooktokkiCloudRestore
  );
  if (isNode) module.exports = api;
  else root.BooktokkiCloudBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(adapter, dryRun, migrationExecutor, cloudRestore){
  "use strict";

  if (!adapter || !dryRun || !migrationExecutor || !cloudRestore){
    throw new Error("Booktokki cloud bootstrap dependencies are required");
  }

  var STATES = Object.freeze({
    EMPTY:"EMPTY",
    LOCAL_ONLY:"LOCAL_ONLY",
    CLOUD_ONLY:"CLOUD_ONLY",
    SYNCED:"SYNCED",
    CONFLICT:"CONFLICT",
    INVALID_CLOUD_STATE:"INVALID_CLOUD_STATE",
    RESUMABLE_MIGRATION:"RESUMABLE_MIGRATION",
    LOCAL_OWNER_MISMATCH:"LOCAL_OWNER_MISMATCH",
    ERROR:"ERROR"
  });
  var LOCAL_OWNER_VERSION = 1;
  var LOCAL_OWNER_KEY = "booktokki:local-owner:v1";

  function readLocalOwner(storage){
    if (!storage || typeof storage.getItem !== "function") throw new Error("readable owner storage is required");
    var raw = storage.getItem(LOCAL_OWNER_KEY);
    if (raw == null) return null;
    var owner = JSON.parse(raw);
    if (!owner || owner.version !== LOCAL_OWNER_VERSION || typeof owner.userId !== "string" || !owner.userId){
      throw new Error("invalid Local owner metadata");
    }
    return { version:LOCAL_OWNER_VERSION, userId:owner.userId };
  }
  function writeLocalOwner(storage, userId){
    if (!storage || typeof storage.setItem !== "function") throw new Error("writable owner storage is required");
    if (typeof userId !== "string" || !userId) throw new Error("Local owner userId is required");
    var owner = { version:LOCAL_OWNER_VERSION, userId:userId };
    storage.setItem(LOCAL_OWNER_KEY, JSON.stringify(owner));
    return owner;
  }

  function safeError(error){
    return {
      name:error && error.name ? String(error.name) : "Error",
      code:error && error.code ? String(error.code) : null,
      status:error && Number.isFinite(error.status) ? error.status : null,
      message:error && error.message ? String(error.message) : "Cloud bootstrap failed"
    };
  }
  function comparableLocalSnapshot(localSnapshot){
    return {
      books:localSnapshot.books.map(function(book){
        var copy = structuredClone(book);
        if (copy.coverId != null){
          copy.coverId = null;
          copy.coverUrl = null;
        }
        return copy;
      }),
      images:[]
    };
  }
  function canonicalTimestamp(value){
    return value == null ? null : new Date(value).toISOString();
  }
  function canonicalizeComparisonTimestamps(normalized){
    var copy = structuredClone(normalized);
    copy.books.forEach(function(book){
      [
        "completed_at",
        "completion_reflection_created_at",
        "completion_reflection_updated_at",
        "created_at",
        "updated_at"
      ].forEach(function(field){ book[field] = canonicalTimestamp(book[field]); });
    });
    copy.readingLogs.forEach(function(log){
      log.recorded_at = canonicalTimestamp(log.recorded_at);
    });
    copy.bookNotes.forEach(function(note){
      note.created_at = canonicalTimestamp(note.created_at);
      note.updated_at = canonicalTimestamp(note.updated_at);
    });
    return copy;
  }
  function countLocal(snapshot){
    return { books:snapshot.books.length, images:snapshot.images.length };
  }
  function countCloud(snapshot){
    return { books:snapshot.books.length, readingLogs:snapshot.readingLogs.length, bookNotes:snapshot.bookNotes.length };
  }

  async function inspectBootstrapState(input){
    var localSnapshot = input.localSnapshot;
    var cloudSnapshot = input.cloudSnapshot;
    var userId = input.userId;
    var journal = input.journal || null;
    var owner = input.owner || null;
    var local = countLocal(localSnapshot);
    var cloud = countCloud(cloudSnapshot);
    var cloudValidation = await cloudRestore.validateCloudRestoreSnapshot(cloudSnapshot, userId);
    if (!cloudValidation.valid){
      return { state:STATES.INVALID_CLOUD_STATE, canStart:false, local:local, cloud:cloud, reason:cloudValidation.error.message };
    }

    var normalized;
    var manifest;
    try {
      normalized = adapter.normalizeLocalSnapshot(localSnapshot, userId);
      manifest = await adapter.createMigrationManifest(normalized);
    } catch (error){
      return { state:STATES.ERROR, canStart:false, local:local, cloud:cloud, reason:error.message, error:safeError(error) };
    }

    if (local.books === 0 && cloud.books === 0){
      return { state:STATES.EMPTY, canStart:true, local:local, cloud:cloud, manifest:manifest, shouldClaimOwner:true };
    }
    if (local.books === 0 && cloud.books > 0){
      return { state:STATES.CLOUD_ONLY, canStart:false, local:local, cloud:cloud, manifest:manifest, shouldClaimOwner:true };
    }

    if (owner && owner.userId !== userId){
      return { state:STATES.LOCAL_OWNER_MISMATCH, canStart:false, local:local, cloud:cloud, manifest:manifest };
    }

    var dryReport = await dryRun.buildMigrationDryRunReport({
      localSnapshot:localSnapshot,
      cloudSnapshot:cloudSnapshot,
      userId:userId,
      journal:journal
    });
    if (dryReport.state === dryRun.STATES.RESUMABLE_MIGRATION){
      return {
        state:STATES.RESUMABLE_MIGRATION,
        canStart:false,
        local:local,
        cloud:cloud,
        manifest:manifest,
        shouldClaimOwner:!owner
      };
    }

    try {
      var comparable = adapter.normalizeLocalSnapshot(comparableLocalSnapshot(localSnapshot), userId);
      var comparableManifest = await adapter.createMigrationManifest(canonicalizeComparisonTimestamps(comparable));
      var cloudComparableManifest = await adapter.createMigrationManifest(canonicalizeComparisonTimestamps(cloudValidation.normalized));
      if (comparableManifest.normalizedContentHash === cloudComparableManifest.normalizedContentHash){
        return {
          state:STATES.SYNCED,
          canStart:true,
          local:local,
          cloud:cloud,
          manifest:manifest,
          shouldClaimOwner:!owner
        };
      }
    } catch (error){
      return { state:STATES.ERROR, canStart:false, local:local, cloud:cloud, reason:error.message, error:safeError(error) };
    }
    if (!owner){
      return { state:STATES.LOCAL_OWNER_MISMATCH, canStart:false, local:local, cloud:cloud, manifest:manifest };
    }
    if (cloud.books === 0){
      return { state:STATES.LOCAL_ONLY, canStart:false, local:local, cloud:cloud, manifest:manifest };
    }
    return { state:STATES.CONFLICT, canStart:false, local:local, cloud:cloud, manifest:manifest };
  }

  function summary(state, action, canStart, local, cloud, extra){
    return Object.assign({
      state:state,
      action:action,
      canStart:canStart,
      local:{ books:local.books, images:local.images },
      cloud:{ books:cloud.books, readingLogs:cloud.readingLogs, bookNotes:cloud.bookNotes }
    }, extra || {});
  }

  async function runSafeCloudBootstrap(options){
    var services = options.services || {};
    var readLocal = services.readLocal || function(){ return dryRun.readLocalMigrationSnapshot(options.database); };
    var readCloud = services.readCloud || function(){ return dryRun.readCloudMigrationSnapshot(options.client, options.userId); };
    var readJournal = services.readJournal || function(){ return dryRun.readMigrationJournal(options.storage, options.userId); };
    var readOwner = services.readOwner || function(){ return readLocalOwner(options.storage); };
    var writeOwner = services.writeOwner || function(){ return writeLocalOwner(options.storage, options.userId); };
    var migrate = services.migrate || function(){
      return migrationExecutor.executeMigration({
        client:options.client,
        storage:options.storage,
        localSnapshot:currentLocal,
        userId:options.userId
      });
    };
    var restore = services.restore || function(){
      return cloudRestore.executeCloudRestore({
        database:options.database,
        client:options.client,
        userId:options.userId,
        journal:currentJournal
      });
    };
    var status = typeof options.onStatus === "function" ? options.onStatus : function(){};
    var currentLocal;
    var currentCloud;
    var currentJournal;
    var currentOwner;
    try {
      status("checking");
      currentLocal = await readLocal();
      currentCloud = await readCloud();
      currentJournal = await readJournal();
      currentOwner = await readOwner();
      var inspected = await inspectBootstrapState({
        localSnapshot:currentLocal,
        cloudSnapshot:currentCloud,
        userId:options.userId,
        journal:currentJournal,
        owner:currentOwner
      });

      if (inspected.state === STATES.EMPTY || inspected.state === STATES.SYNCED){
        if (inspected.shouldClaimOwner) await writeOwner();
        return summary(inspected.state, "none", true, inspected.local, inspected.cloud, { writes:{ local:0, cloud:0 } });
      }
      if (inspected.state === STATES.CONFLICT || inspected.state === STATES.INVALID_CLOUD_STATE
          || inspected.state === STATES.LOCAL_OWNER_MISMATCH || inspected.state === STATES.ERROR){
        return summary(inspected.state, "blocked", false, inspected.local, inspected.cloud, {
          writes:{ local:0, cloud:0 }, reason:inspected.reason || null
        });
      }

      var actionResult;
      var action;
      if (inspected.state === STATES.LOCAL_ONLY || inspected.state === STATES.RESUMABLE_MIGRATION){
        action = inspected.state === STATES.RESUMABLE_MIGRATION ? "resume_migration" : "migration";
        status(action);
        actionResult = await migrate();
      } else if (inspected.state === STATES.CLOUD_ONLY){
        action = "restore";
        status(action);
        actionResult = await restore();
      }
      if (!actionResult || !actionResult.success){
        return summary(STATES.ERROR, action, false, inspected.local, inspected.cloud, {
          writes:{
            local:actionResult && actionResult.localWrites ? actionResult.localWrites : 0,
            cloud:actionResult && actionResult.written
              ? actionResult.written.books + actionResult.written.readingLogs + actionResult.written.bookNotes
              : 0
          },
          operation:actionResult || null,
          reason:actionResult && actionResult.error ? actionResult.error.message : "Bootstrap operation failed"
        });
      }

      status("verifying");
      currentLocal = await readLocal();
      currentCloud = await readCloud();
      currentJournal = await readJournal();
      currentOwner = await readOwner();
      var verificationOwner = action === "restore"
        ? { version:LOCAL_OWNER_VERSION, userId:options.userId }
        : currentOwner;
      var after = await inspectBootstrapState({
        localSnapshot:currentLocal,
        cloudSnapshot:currentCloud,
        userId:options.userId,
        journal:currentJournal,
        owner:verificationOwner
      });
      if (after.state !== STATES.SYNCED){
        return summary(STATES.ERROR, action, false, after.local, after.cloud, {
          writes:{
            local:action === "restore" ? actionResult.localWrites : 0,
            cloud:actionResult.written
              ? actionResult.written.books + actionResult.written.readingLogs + actionResult.written.bookNotes
              : 0
          },
          reason:"Bootstrap verification did not reach SYNCED"
        });
      }
      if (inspected.shouldClaimOwner || after.shouldClaimOwner) await writeOwner();
      return summary(STATES.SYNCED, action, true, after.local, after.cloud, {
        writes:{
          local:action === "restore" ? actionResult.localWrites : 0,
          cloud:actionResult.written
            ? actionResult.written.books + actionResult.written.readingLogs + actionResult.written.bookNotes
            : 0
        },
        verificationPassed:true
      });
    } catch (error){
      return {
        state:STATES.ERROR,
        action:"error",
        canStart:false,
        writes:{ local:0, cloud:0 },
        error:safeError(error)
      };
    }
  }

  return {
    STATES:STATES,
    LOCAL_OWNER_VERSION:LOCAL_OWNER_VERSION,
    LOCAL_OWNER_KEY:LOCAL_OWNER_KEY,
    readLocalOwner:readLocalOwner,
    writeLocalOwner:writeLocalOwner,
    comparableLocalSnapshot:comparableLocalSnapshot,
    canonicalizeComparisonTimestamps:canonicalizeComparisonTimestamps,
    inspectBootstrapState:inspectBootstrapState,
    runSafeCloudBootstrap:runSafeCloudBootstrap
  };
});
