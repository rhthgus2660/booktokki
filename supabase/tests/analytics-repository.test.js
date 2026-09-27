"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var analytics = require("../../analytics-repository.js");

var user = "11111111-1111-4111-8111-111111111111";
var other = "22222222-2222-4222-8222-222222222222";
var bookId = "33333333-3333-4333-8333-333333333333";
var at = "2026-09-27T01:02:03.000Z";

function mockClient(){
  var rows = [];
  var fail = false;
  return {
    from:function(table){
      assert.equal(table, "analytics_events");
      return { insert:function(row){
        if (fail) return Promise.resolve({ data:null, error:{ code:"NETWORK", message:"offline" } });
        var duplicate = rows.some(function(item){ return item.event_id === row.event_id; });
        if (duplicate) return Promise.resolve({ data:null, error:{ code:"23505" } });
        rows.push(Object.assign({}, row));
        return Promise.resolve({ data:null, error:null });
      }};
    },
    rows:rows,
    setFailure:function(value){ fail = value; }
  };
}

function sessionHarness(){
  var events = [];
  var session = analytics.createReadingRecordSession({
    eventId:"reading-session",
    bookId:bookId,
    send:function(event){ events.push(event); }
  });
  return { session:session, events:events };
}

(async function(){
  var client = mockClient();
  var repository = analytics.create(client);

  var add = analytics.bookAddedEvent("book-added-action", bookId, at);
  assert.deepEqual(await repository.recordEvent(user, add), { created:true, duplicate:false });
  assert.deepEqual(await repository.recordEvent(user, add), { created:false, duplicate:true });
  assert.equal(client.rows.length, 1);
  assert.equal(client.rows[0].with_note, null);

  var noThought = analytics.readingRecordEvent("read-1", bookId, at, { pageSaved:true, noteSaved:false });
  var withThought = analytics.readingRecordEvent("read-2", bookId, at, { pageSaved:true, noteSaved:true });
  var samePageWithThought = analytics.readingRecordEvent("read-3", bookId, at, { pageSaved:true, noteSaved:true });
  var samePageOnly = analytics.readingRecordEvent("read-4", bookId, at, { pageSaved:true, noteSaved:false });
  var partial = analytics.readingRecordEvent("read-5", bookId, at, { pageSaved:true, noteSaved:false, partial:true });
  assert.equal(noThought.withNote, false);
  assert.equal(withThought.withNote, true);
  assert.equal(samePageWithThought.withNote, true);
  assert.equal(samePageOnly.withNote, false);
  assert.equal(partial.withNote, false);
  assert.equal(analytics.readingRecordEvent("failed", bookId, at, { pageSaved:false }), null);

  var pageAndNote = sessionHarness();
  pageAndNote.session.handleResult({ pageSaved:true, noteSaved:true, partial:false }, at);
  assert.equal(pageAndNote.events.length, 1);
  assert.equal(pageAndNote.events[0].withNote, true);

  var pageOnly = sessionHarness();
  pageOnly.session.handleResult({ pageSaved:true, noteSaved:false, partial:false }, at);
  assert.equal(pageOnly.events.length, 1);
  assert.equal(pageOnly.events[0].withNote, false);

  var partialOnly = sessionHarness();
  partialOnly.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  assert.equal(partialOnly.events.length, 0);

  var retrySuccess = sessionHarness();
  retrySuccess.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  retrySuccess.session.handleResult({ pageSaved:true, noteSaved:true, partial:false }, at);
  assert.equal(retrySuccess.events.length, 1);
  assert.equal(retrySuccess.events[0].withNote, true);

  var repeatedRetrySuccess = sessionHarness();
  repeatedRetrySuccess.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  repeatedRetrySuccess.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  repeatedRetrySuccess.session.handleResult({ pageSaved:true, noteSaved:true, partial:false }, at);
  assert.equal(repeatedRetrySuccess.events.length, 1);
  assert.equal(repeatedRetrySuccess.events[0].withNote, true);

  var partialClose = sessionHarness();
  partialClose.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  partialClose.session.close();
  assert.equal(partialClose.events.length, 1);
  assert.equal(partialClose.events[0].withNote, false);

  var repeatedPartialClose = sessionHarness();
  repeatedPartialClose.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  repeatedPartialClose.session.handleResult({ pageSaved:true, noteSaved:false, partial:true }, at);
  repeatedPartialClose.session.close();
  assert.equal(repeatedPartialClose.events.length, 1);
  assert.equal(repeatedPartialClose.events[0].withNote, false);

  pageAndNote.session.close();
  pageAndNote.session.handleResult({ pageSaved:true, noteSaved:true, partial:false }, at);
  assert.equal(pageAndNote.events.length, 1);

  var analyticsFailure = analytics.createReadingRecordSession({
    eventId:"analytics-failure",
    bookId:bookId,
    send:function(){ throw new Error("analytics unavailable"); }
  });
  assert.doesNotThrow(function(){
    analyticsFailure.handleResult({ pageSaved:true, noteSaved:true, partial:false }, at);
    analyticsFailure.close();
  });
  assert.equal(analyticsFailure.state().fired, true);

  await repository.recordEvent(user, withThought);
  await repository.recordEvent(user, withThought);
  assert.equal(client.rows.filter(function(row){ return row.event_id === "read-2"; }).length, 1);

  assert.deepEqual(await repository.recordEvent(other, add), { created:false, duplicate:true });
  assert.equal(client.rows.length, 2);

  client.setFailure(true);
  var observed = null;
  var safe = await analytics.trackSafely(repository, user, noThought, function(error){ observed = error; });
  assert.equal(safe, false);
  assert.equal(observed.code, "NETWORK");

  var row = analytics.eventRow(user, withThought);
  ["title", "author", "query", "page", "previous_page", "current_page", "text"].forEach(function(key){
    assert.equal(Object.prototype.hasOwnProperty.call(row, key), false);
  });

  var sql = fs.readFileSync(path.join(__dirname, "../migrations/202609270001_minimal_analytics.sql"), "utf8");
  assert.match(sql, /event_id text primary key/);
  assert.match(sql, /book_id uuid not null,/);
  assert.doesNotMatch(sql, /book_id[^\n]*references public\.books/i);
  assert.match(sql, /grant insert on table public\.analytics_events to authenticated/);
  assert.doesNotMatch(sql, /grant[^;]*(select|update|delete)[^;]*analytics_events/i);
  assert.match(sql, /\(select auth\.uid\(\)\) = analytics_events\.user_id/);
  assert.match(sql, /where b\.id = analytics_events\.book_id[\s\S]*b\.user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(sql, /policy analytics_events_(select|update|delete)/i);

  var indexSource = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
  var addBookSource = indexSource.slice(indexSource.indexOf("function addBook("), indexSource.indexOf("function buildPageLogPatch("));
  var modalSource = indexSource.slice(indexSource.indexOf("function modalLogPage("), indexSource.indexOf("/* ---------------- event delegation"));
  var standaloneNoteSource = indexSource.slice(indexSource.indexOf("function addNote("), indexSource.indexOf("function saveCompletionReflection("));
  assert.match(addBookSource, /bookAddedEvent\("book_added:" \+ id, cloudBookId, data\.createdAt\)/);
  assert.match(modalSource, /createReadingRecordSession\(/);
  assert.match(modalSource, /analyticsSession\.handleResult\(result, analyticsOccurredAt\)/);
  assert.match(modalSource, /modalBeforeClose = function\(\)\{ if \(analyticsSession\) analyticsSession\.close\(\); \}/);
  assert.doesNotMatch(modalSource, /analyticsSeed\.withNote/);
  assert.doesNotMatch(standaloneNoteSource, /trackAnalyticsEvent|readingRecordEvent/);
  ["cloud-bootstrap.js", "cloud-restore.js", "migration-adapter.js", "migration-dry-run.js", "migration-executor.js"].forEach(function(file){
    var source = fs.readFileSync(path.join(__dirname, "../" + file), "utf8");
    assert.doesNotMatch(source, /analytics_events|trackAnalyticsEvent|bookAddedEvent/);
  });
  console.log("PASS minimal analytics repository and schema tests");
})().catch(function(error){ console.error("FAIL minimal analytics tests", error); process.exitCode = 1; });
