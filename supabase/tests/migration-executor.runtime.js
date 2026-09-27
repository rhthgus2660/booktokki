(async function(){
  "use strict";

  function loadScript(src, globalName){
    if (window[globalName]) return Promise.resolve();
    return new Promise(function(resolve, reject){
      var script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = function(){ reject(new Error("Failed to load " + src)); };
      document.head.appendChild(script);
    });
  }

  await loadScript("./supabase/migration-adapter.js", "BooktokkiMigrationAdapter");
  await loadScript("./supabase/migration-dry-run.js", "BooktokkiMigrationDryRun");
  await loadScript("./supabase/migration-executor.js", "BooktokkiMigrationExecutor");

  var config = window.BOOKTOKKI_AUTH_CONFIG || {};
  var library = window.supabase;
  if (!library || typeof library.createClient !== "function") throw new Error("Supabase browser library is unavailable");
  if (!config.supabaseUrl || !config.supabaseAnonKey) throw new Error("Supabase public configuration is unavailable");

  var client = library.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth:{ persistSession:true, autoRefreshToken:false, detectSessionInUrl:false }
  });
  var sessionResult = await client.auth.getSession();
  if (sessionResult.error) throw sessionResult.error;
  var session = sessionResult.data.session;
  if (!session) throw new Error("Log in first: no authenticated session");

  var dryRun = window.BooktokkiMigrationDryRun;
  var executor = window.BooktokkiMigrationExecutor;
  var database = await dryRun.openExistingLocalDatabase(window.indexedDB);
  var localSnapshot = database
    ? await dryRun.readLocalMigrationSnapshot(database)
    : { books:[], images:[] };
  if (database) database.close();

  var prepared = await executor.prepareMigrationExecution({
    client:client,
    storage:window.localStorage,
    localSnapshot:localSnapshot,
    userId:session.user.id
  });
  console.log("BOOKTOKKI_MIGRATION_PREFLIGHT", prepared.report);
  console.table({
    state:prepared.report.state,
    canMigrate:prepared.report.canMigrate,
    validationPassed:prepared.report.validation.passed,
    localBooks:prepared.report.local.books,
    cloudBooks:prepared.report.cloudBefore.books,
    manifestHash:prepared.report.manifestHash
  });

  var allowed = prepared.report.state === dryRun.STATES.LOCAL_ONLY
    || prepared.report.state === dryRun.STATES.RESUMABLE_MIGRATION
    || (prepared.journal && prepared.journal.status === "complete");
  if (!allowed){
    return { success:false, cancelled:false, blocked:true, preflight:prepared.report };
  }

  var message = prepared.report.state === dryRun.STATES.RESUMABLE_MIGRATION
    ? "중단된 Booktokki Cloud 복사를 안전하게 이어서 진행합니다. Local 데이터는 삭제되지 않습니다. 계속할까요?"
    : prepared.journal && prepared.journal.status === "complete"
      ? "완료된 Cloud 복사 상태를 다시 검증합니다. 새 데이터는 생성하지 않습니다. 계속할까요?"
      : "Local " + prepared.report.local.books + "권을 Booktokki Cloud로 복사합니다. Local 데이터는 삭제되지 않습니다. 계속할까요?";
  if (!window.confirm(message)){
    var cancelled = { success:false, cancelled:true, blocked:false, preflight:prepared.report };
    console.log("BOOKTOKKI_MIGRATION_RESULT", cancelled);
    return cancelled;
  }

  var result = await executor.executeMigration({
    client:client,
    storage:window.localStorage,
    localSnapshot:localSnapshot,
    userId:session.user.id
  });
  console.log("BOOKTOKKI_MIGRATION_RESULT", result);
  console.table({
    success:result.success,
    resumed:result.resumed,
    manifestHash:result.manifestHash,
    writtenBooks:result.written && result.written.books,
    writtenReadingLogs:result.written && result.written.readingLogs,
    writtenBookNotes:result.written && result.written.bookNotes,
    verificationPassed:result.verificationPassed,
    journalStatus:result.journalStatus,
    localPreserved:result.localPreserved
  });
  return result;
})().catch(function(error){
  console.error("BOOKTOKKI_MIGRATION_EXECUTOR_FAILED", error);
  throw error;
});
