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
  var database = await dryRun.openExistingLocalDatabase(window.indexedDB);
  var localSnapshot = database
    ? await dryRun.readLocalMigrationSnapshot(database)
    : { books:[], images:[] };
  if (database) database.close();

  var cloudSnapshot = await dryRun.readCloudMigrationSnapshot(client, session.user.id);
  var journal = dryRun.readMigrationJournal(window.localStorage, session.user.id);
  var report = await dryRun.buildMigrationDryRunReport({
    localSnapshot:localSnapshot,
    cloudSnapshot:cloudSnapshot,
    userId:session.user.id,
    journal:journal
  });

  console.log("BOOKTOKKI_MIGRATION_DRY_RUN", report);
  console.table({
    state:report.state,
    canMigrate:report.canMigrate,
    localBooks:report.local.books,
    cloudBooks:report.cloudBefore.books,
    manifestHash:report.manifestHash,
    validationPassed:report.validation.passed
  });
  return report;
})().catch(function(error){
  console.error("BOOKTOKKI_MIGRATION_DRY_RUN_FAILED", error);
  throw error;
});
