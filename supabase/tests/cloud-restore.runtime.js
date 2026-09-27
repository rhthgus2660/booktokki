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
  await loadScript("./supabase/cloud-restore.js", "BooktokkiCloudRestore");

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
  var cloudRestore = window.BooktokkiCloudRestore;
  var database = await dryRun.openExistingLocalDatabase(window.indexedDB);
  if (!database) throw new Error("Booktokki IndexedDB is unavailable; reload the app once and retry");

  var journal = null;
  try { journal = dryRun.readMigrationJournal(window.localStorage, session.user.id); }
  catch (journalError){ console.warn("Migration journal is unavailable on this browser", journalError); }

  var prepared = await cloudRestore.prepareCloudRestore({ database:database, client:client, userId:session.user.id });
  console.log("BOOKTOKKI_CLOUD_RESTORE_PREFLIGHT", {
    state:prepared.state,
    canRestore:prepared.canRestore,
    local:prepared.local,
    cloud:prepared.cloud,
    validation:prepared.validation
  });
  console.table({
    state:prepared.state,
    canRestore:prepared.canRestore,
    localBooks:prepared.local.books,
    localImages:prepared.local.images,
    cloudBooks:prepared.cloud.books,
    cloudReadingLogs:prepared.cloud.readingLogs,
    cloudBookNotes:prepared.cloud.bookNotes,
    validationPassed:prepared.validation.passed
  });

  if (!prepared.canRestore){
    database.close();
    var blocked = {
      success:false,
      blocked:true,
      stateBefore:prepared.state,
      canRestore:false,
      localWrites:0
    };
    console.log("BOOKTOKKI_CLOUD_RESTORE_RESULT", blocked);
    return blocked;
  }

  if (!window.confirm("Cloud의 Booktokki 기록 " + prepared.cloud.books + "권을 이 브라우저에 복원합니다. Cloud 데이터는 변경되지 않습니다. 계속할까요?")){
    database.close();
    var cancelled = { success:false, cancelled:true, stateBefore:prepared.state, localWrites:0 };
    console.log("BOOKTOKKI_CLOUD_RESTORE_RESULT", cancelled);
    return cancelled;
  }

  var result = await cloudRestore.executeCloudRestore({
    database:database,
    client:client,
    userId:session.user.id,
    journal:journal
  });
  database.close();
  console.log("BOOKTOKKI_CLOUD_RESTORE_RESULT", result);
  console.table({
    success:result.success,
    stateBefore:result.stateBefore,
    restoredBooks:result.restored && result.restored.books,
    restoredReadingLogs:result.restored && result.restored.readingLogs,
    restoredBookNotes:result.restored && result.restored.bookNotes,
    verificationPassed:result.verificationPassed,
    cloudUnchanged:result.cloudUnchanged,
    localWriteCompleted:result.localWriteCompleted
  });
  return result;
})().catch(function(error){
  console.error("BOOKTOKKI_CLOUD_RESTORE_FAILED", error);
  throw error;
});
