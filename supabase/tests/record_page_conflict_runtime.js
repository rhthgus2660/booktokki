(async function(){
  "use strict";

  var config = window.BOOKTOKKI_AUTH_CONFIG || {};
  var library = window.supabase;
  if (!library || typeof library.createClient !== "function"){
    throw new Error("Supabase browser library is unavailable");
  }
  if (!config.supabaseUrl || !config.supabaseAnonKey){
    throw new Error("Supabase public configuration is unavailable");
  }
  var client = library.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  var sessionResult = await client.auth.getSession();
  if (sessionResult.error) throw sessionResult.error;
  var session = sessionResult.data.session;
  if (!session) throw new Error("Log in first: no authenticated session");

  var suffix = Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  var bookClientId = "runtime_test_book_" + suffix;
  var logForward = "runtime_test_log_forward_" + suffix;
  var logSame = "runtime_test_log_same_" + suffix;
  var logBackward = "runtime_test_log_backward_" + suffix;
  var logStale = "runtime_test_log_stale_" + suffix;
  var bookId = null;
  var report = {};

  function localDate(){
    var d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  }

  async function rpc(body){
    var response = await fetch(config.supabaseUrl + "/rest/v1/rpc/record_page", {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    var text = await response.text();
    var payload = text ? JSON.parse(text) : null;
    return { status: response.status, ok: response.ok, payload: payload };
  }

  async function readBook(){
    var result = await client.from("books")
      .select("id,current_page,revision,status")
      .eq("id", bookId)
      .single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function countLog(clientId){
    var result = await client.from("reading_logs")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId);
    if (result.error) throw result.error;
    return result.count || 0;
  }

  function args(revision, clientId, page){
    return {
      p_book_id: bookId,
      p_expected_revision: revision,
      p_log_client_id: clientId,
      p_new_page: page,
      p_log_date: localDate(),
      p_recorded_at: new Date().toISOString()
    };
  }

  try {
    var inserted = await client.from("books").insert({
      user_id: session.user.id,
      client_id: bookClientId,
      title: "__BOOKTOKKI_RUNTIME_TEST__ conflict 409",
      author: "runtime test",
      total_pages: 100,
      current_page: 0,
      status: "toread"
    }).select("id,current_page,revision").single();
    if (inserted.error) throw inserted.error;
    bookId = inserted.data.id;

    var forward = await rpc(args(inserted.data.revision, logForward, 10));
    var afterForward = await readBook();
    report.normal_rpc_success = forward.status === 200
      && afterForward.current_page === 10
      && await countLog(logForward) === 1;

    var retry = await rpc(args(inserted.data.revision, logForward, 10));
    report.idempotent_retry = retry.status === 200
      && await countLog(logForward) === 1;

    var same = await rpc(args(afterForward.revision, logSame, 10));
    var afterSame = await readBook();
    report.same_page_no_log = same.status === 200
      && afterSame.current_page === 10
      && await countLog(logSame) === 0;

    var backward = await rpc(args(afterSame.revision, logBackward, 5));
    var beforeStale = await readBook();
    report.backward_page_record = backward.status === 200
      && beforeStale.current_page === 5
      && await countLog(logBackward) === 1;

    var stale = await rpc(args(afterSame.revision, logStale, 20));
    var afterStale = await readBook();
    report.stale_http_409 = stale.status === 409;
    report.stale_error_code_pt409 = Boolean(stale.payload && stale.payload.code === "PT409");
    report.stale_log_not_created = await countLog(logStale) === 0;
    report.stale_current_page_unchanged = afterStale.current_page === beforeStale.current_page;
    report.stale_revision_unchanged = afterStale.revision === beforeStale.revision;
    report.stale_no_partial_write = report.stale_log_not_created
      && report.stale_current_page_unchanged
      && report.stale_revision_unchanged;
  } finally {
    if (bookId){
      var removed = await client.from("books").delete().eq("id", bookId);
      if (removed.error) console.error("Runtime cleanup failed", removed.error);
    }
    var remainingBooks = await client.from("books")
      .select("id", { count: "exact", head: true })
      .eq("client_id", bookClientId);
    var remainingLogs = await client.from("reading_logs")
      .select("id", { count: "exact", head: true })
      .in("client_id", [logForward, logSame, logBackward, logStale]);
    report.cleanup_book_rows_zero = !remainingBooks.error && (remainingBooks.count || 0) === 0;
    report.cleanup_log_rows_zero = !remainingLogs.error && (remainingLogs.count || 0) === 0;
  }

  report.all_passed = Object.keys(report).every(function(key){
    return key === "all_passed" || report[key] === true;
  });
  console.table(report);
  console.log("BOOKTOKKI_RUNTIME_RESULT_V2", report);
  return report;
})().catch(function(error){
  console.error("BOOKTOKKI_RUNTIME_TEST_FAILED", error);
  throw error;
});
