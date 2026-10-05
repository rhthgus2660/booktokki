"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

function localDate(offset){
  var now = new Date();
  var date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

var resumeSource = html.slice(
  html.indexOf("function latestPositivePageLog("),
  html.indexOf("// Home-only: actual positive page history")
);
var resumeHelpers = new Function(
  resumeSource + "; return { latest:latestPositivePageLog, days:calendarDaysSince, context:resumeContextForBook };"
)();

var now = new Date();
var baseBook = { currentPage:83, pageLogs:[] };
assert.equal(resumeHelpers.context(baseBook, now), null);

baseBook.pageLogs = [
  { id:"negative", delta:-5, date:localDate(0), at:new Date(now.getTime() + 1000).toISOString() },
  { id:"positive", delta:20, date:localDate(0), at:now.toISOString() }
];
assert.equal(resumeHelpers.context(baseBook, now), "83p · 오늘");

baseBook.pageLogs = [{ id:"positive", delta:20, date:localDate(-1), at:now.toISOString() }];
assert.equal(resumeHelpers.context(baseBook, now), "83p · 어제");

baseBook.pageLogs = [{ id:"positive", delta:20, date:localDate(-5), at:now.toISOString() }];
assert.equal(resumeHelpers.context(baseBook, now), "83p · 5일 전");

baseBook.pageLogs = [
  { id:"older", delta:20, date:localDate(-5), at:new Date(now.getTime() - 2000).toISOString() },
  { id:"newer", delta:10, date:localDate(-1), at:new Date(now.getTime() - 1000).toISOString() },
  { id:"correction", delta:-2, date:localDate(0), at:now.toISOString() }
];
assert.equal(resumeHelpers.context(baseBook, now), "83p · 어제");
baseBook.pageLogs = [{ id:"invalid", delta:5, date:"invalid", at:now.toISOString() }];
assert.equal(resumeHelpers.context(baseBook, now), "83p");
baseBook.pageLogs = [{ id:"future", delta:5, date:localDate(1), at:now.toISOString() }];
assert.equal(resumeHelpers.context(baseBook, now), "83p");

var recentSource = html.slice(
  html.indexOf("function getRecentReadingBooks("),
  html.indexOf("/* \"오늘 기록\"")
);
var recentBooks = [
  { id:"started-new", status:"reading", createdAt:"2026-01-01T00:00:00.000Z", pageLogs:[{ delta:5, at:"2026-09-29T00:00:00.000Z" }] },
  { id:"started-old", status:"reading", createdAt:"2026-01-02T00:00:00.000Z", pageLogs:[{ delta:5, at:"2026-09-20T00:00:00.000Z" }] },
  { id:"unstarted-new", status:"toread", createdAt:"2026-09-28T00:00:00.000Z", pageLogs:[] },
  { id:"unstarted-old", status:"toread", createdAt:"2026-09-27T00:00:00.000Z", pageLogs:[] },
  { id:"done", status:"done", createdAt:"2026-09-29T00:00:00.000Z", pageLogs:[{ delta:50, at:"2026-09-29T01:00:00.000Z" }] }
];
var getRecentReadingBooks = new Function(
  "getBooks", recentSource + "; return getRecentReadingBooks;"
)(function(){ return recentBooks; });
assert.deepEqual(getRecentReadingBooks().map(function(item){ return item.id; }), ["started-new", "started-old", "unstarted-new"]);

var miniSource = html.slice(
  html.indexOf("function currentBookMini("),
  html.indexOf("function renderHome(")
);
var renderMini = new Function(
  "getRecentReadingBooks", "pct", "coverEl", "esc", "resumeContextForBook", "window", "getBooks", "continueReadingReady",
  miniSource + "; return currentBookMini;"
)(
  function(){ return [{ id:"book", title:"책", author:"저자", currentPage:83, totalPages:200, pageLogs:[{ delta:10 }] }]; },
  function(){ return 42; },
  function(){ return '<div class="cover"></div>'; },
  function(value){ return String(value); },
  function(){ return "83p · 5일 전"; },
  {BooktokkiContinueReading:require("../../continue-reading.js")}, function(){return [];}, false
);
var miniMarkup = renderMini();
assert.match(miniMarkup, /class="book-resume">83p · 5일 전</);
assert.match(miniMarkup, /\+ 읽은 페이지/);
assert.match(miniMarkup, /width:42%/);

var reactionSource = html.slice(
  html.indexOf("function readingReaction("),
  html.indexOf("var rabbitEventTimer")
);
function reactionHarness(books){
  return new Function(
    "getBooks", "calendarDaysSince",
    reactionSource + "; return readingReaction;"
  )(
    function(){ return books; },
    resumeHelpers.days
  );
}
function bookWithLog(date, options){
  options = options || {};
  return {
    id:options.id || "book",
    currentPage:options.currentPage == null ? 10 : options.currentPage,
    totalPages:options.totalPages || 200,
    pageLogs:date ? [{ id:"old", delta:10, date:date, at:options.at || "2026-01-01T00:00:00.000Z" }] : []
  };
}

var book = bookWithLog(null);
assert.equal(reactionHarness([book])(book, 20), "A");
book = bookWithLog(localDate(0));
assert.equal(reactionHarness([book])(book, 20), "A");
book = bookWithLog(localDate(-1));
assert.equal(reactionHarness([book])(book, 20), "B");
book = bookWithLog(localDate(-5));
assert.equal(reactionHarness([book])(book, 20), "B");
assert.equal(reactionHarness([book])(book, book.currentPage), null);
assert.equal(reactionHarness([book])(book, book.currentPage - 1), null);

book = bookWithLog(localDate(-1), { currentPage:190, totalPages:200 });
assert.equal(reactionHarness([book])(book, 200), "E");
book = bookWithLog(localDate(-1), { currentPage:10, totalPages:500 });
var other = bookWithLog(localDate(0), { id:"other", at:"2099-01-01T00:00:00.000Z" });
assert.equal(reactionHarness([book, other])(book, 100), "B");
book = bookWithLog(localDate(0), { currentPage:10, totalPages:500, at:"2026-01-01T00:00:00.000Z" });
other = bookWithLog(localDate(0), { id:"other", at:"2099-01-01T00:00:00.000Z" });
assert.equal(reactionHarness([book, other])(book, 20), "C");
book = bookWithLog(localDate(0), { currentPage:10, totalPages:500, at:"2099-01-01T00:00:00.000Z" });
assert.equal(reactionHarness([book])(book, 60), "D");

var librarySource = html.slice(
  html.indexOf("function libraryTraceForBook("),
  html.indexOf("function latestPositiveBookId(")
);
var libraryTrace = new Function(librarySource + "; return libraryTraceForBook;")();
var traceBook = {
  id:"book", notes:[], pageLogs:[
    { delta:10, date:"2026-09-20", at:"2026-09-20T00:00:00.000Z" },
    { delta:10, date:"2026-09-21", at:"2026-09-21T00:00:00.000Z" }
  ]
};
assert.equal(libraryTrace(traceBook, null).returnCount, 0);
traceBook.pageLogs[1] = { delta:10, date:"2026-09-23", at:"2026-09-23T00:00:00.000Z" };
assert.equal(libraryTrace(traceBook, null).returnCount, 1);

var logPageSource = html.slice(
  html.indexOf("function logPage("),
  html.indexOf("// Read existing page history")
);
function logPageHarness(shouldFail){
  var shown = [];
  var state = { books:{ book:{ id:"book", currentPage:10, totalPages:100, pageLogs:[] } } };
  var logPage = new Function(
    "state", "queueCloudMutation", "getBooks", "buildPageLogPatch", "readingReaction", "todayStr", "uid",
    "cloudRepository", "activeAuthUserId", "localBookFromCloudRow", "commitLocalBook", "document",
    "showReadingReaction", "queueFirstRecordFeedbackPrompt", "cloudSaveFailed", "continueReadingFlow",
    logPageSource + "; return logPage;"
  )(
    state,
    function(_id, action){ return action(); },
    function(){ return [state.books.book]; },
    function(current, page){ return { currentPage:page, updatedAt:now.toISOString(), pageLogs:current.pageLogs.concat([{ id:"log", delta:page-current.currentPage, date:localDate(0), at:now.toISOString() }]) }; },
    function(){ return "B"; },
    function(){ return localDate(0); },
    function(){ return "id"; },
    { recordPage:function(){ return shouldFail ? Promise.reject(new Error("offline")) : Promise.resolve({ logCreated:true, logs:[{ id:"log" }], book:{} }); } },
    "user",
    function(candidate){ return candidate; },
    function(candidate){ state.books.book = candidate; return Promise.resolve(candidate); },
    { querySelector:function(){ return null; } },
    function(mode){ shown.push(mode); },
    function(){},
    function(){},
    require("../../continue-reading.js").createFlow()
  );
  return { logPage:logPage, shown:shown };
}

(async function(){
  var successful = logPageHarness(false);
  assert.equal(await successful.logPage("book", 20), true);
  assert.deepEqual(successful.shown, ["B"]);

  var failed = logPageHarness(true);
  assert.equal(await failed.logPage("book", 20), false);
  assert.deepEqual(failed.shown, []);

  var reactionUiSource = html.slice(
    html.indexOf("var rabbitEventTimer"),
    html.indexOf("function addNote(")
  );
  var timerDelay = null;
  var timerCallback = null;
  var element = { hidden:true, innerHTML:"", dataset:{}, classList:{ add:function(){}, remove:function(){} }, offsetWidth:1 };
  var reactionUi = new Function(
    "document", "clearTimeout", "setTimeout",
    reactionUiSource + "; return { show:showReadingReaction };"
  )(
    { getElementById:function(){ return element; } },
    function(){},
    function(callback, delay){ timerCallback = callback; timerDelay = delay; return 1; }
  );
  reactionUi.show("B", "seed");
  assert.equal(element.hidden, false);
  assert.equal(timerDelay, 4000);
  timerCallback();
  assert.equal(element.hidden, true);

  console.log("PASS Phase 1 Resume Card and Return Reaction tests");
})().catch(function(error){
  console.error("FAIL Phase 1 Resume Card and Return Reaction tests", error);
  process.exitCode = 1;
});
