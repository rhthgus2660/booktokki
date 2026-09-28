"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

var memorySource = html.slice(
  html.indexOf("function readingMemoryForBook("),
  html.indexOf("function renderDetail(")
);
var memory = new Function(
  "fmtMonthDay", "esc",
  memorySource + "; return { select:readingMemoryForBook, markup:readingMemoryHtml };"
)(
  function(value){ var date = new Date(value); return (date.getMonth() + 1) + "." + date.getDate(); },
  function(value){ return String(value).replace(/[&<>\"']/g, function(character){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '\"':"&quot;", "'":"&#39;" }[character]; }); }
);

function note(id, createdAt, text, page){
  return { id:id, bookId:"book", createdAt:createdAt, text:text, page:page };
}

var older = note("older", "2026-09-20T01:00:00.000Z", "예전 생각", 12);
var latest = note("latest", "2026-09-21T01:00:00.000Z", "최근 생각", 31);
var book = { id:"book", notes:[older, latest] };

assert.equal(memory.select(book, "other", ["older", "latest"]), null);
assert.equal(memory.select(book, "book", []), null);

var selected = memory.select(book, "book", ["older", "latest"]);
assert.equal(selected.id, "latest");
assert.match(memory.markup(selected), /지난 북로그/);
assert.match(memory.markup(selected), /p\.31 · 9\.21/);
assert.match(memory.markup(selected), /최근 생각/);

var withoutPage = note("without-page", "2026-09-22T01:00:00.000Z", "페이지 없음", null);
var withoutPageMarkup = memory.markup(withoutPage);
assert.match(withoutPageMarkup, /9\.22/);
assert.doesNotMatch(withoutPageMarkup, /p\./);

var unsafe = note("unsafe", "2026-09-22T02:00:00.000Z", "<script>위험</script>", 40);
assert.match(memory.markup(unsafe), /&lt;script&gt;위험&lt;\/script&gt;/);
assert.doesNotMatch(memory.markup(unsafe), /<script>/);

var navigationSource = html.slice(
  html.indexOf("function openBook("),
  html.indexOf("/* ---------------- render ---------------- */")
);
function navigationHarness(initialBook){
  var state = { books:{ book:initialBook }, detailFrom:"library", detailEntryBookId:null, detailEntryNoteIds:[] };
  var rendered = 0;
  var openBook = new Function(
    "state", "goTo", navigationSource + "; return openBook;"
  )(
    state,
    function(view, bookId){ state.view = view; state.selectedBookId = bookId; rendered += 1; }
  );
  return { state:state, openBook:openBook, rendered:function(){ return rendered; } };
}

/* Cloud restore/load has already populated state before the first Detail entry. */
var nav = navigationHarness({ id:"book", notes:[older, latest] });
nav.openBook("book", "home");
assert.equal(nav.state.view, "detail");
assert.equal(nav.state.detailFrom, "home");
assert.deepEqual(nav.state.detailEntryNoteIds, ["older", "latest"]);
assert.equal(nav.rendered(), 1);

/* A new note written during this Detail visit is not in the entry snapshot. */
var justWritten = note("new", "2026-09-22T03:00:00.000Z", "방금 쓴 생각", 55);
nav.state.books.book = Object.assign({}, nav.state.books.book, { notes:[older, latest, justWritten] });
assert.equal(memory.select(nav.state.books.book, nav.state.detailEntryBookId, nav.state.detailEntryNoteIds).id, "latest");

/* Editing keeps the ID, so the resurfaced note reflects its current text. */
var editedLatest = Object.assign({}, latest, { text:"수정된 최근 생각" });
nav.state.books.book = Object.assign({}, nav.state.books.book, { notes:[older, editedLatest, justWritten] });
selected = memory.select(nav.state.books.book, nav.state.detailEntryBookId, nav.state.detailEntryNoteIds);
assert.equal(selected.id, "latest");
assert.equal(selected.text, "수정된 최근 생각");

/* Deleting the latest eligible note falls back to the next eligible note. */
nav.state.books.book = Object.assign({}, nav.state.books.book, { notes:[older, justWritten] });
assert.equal(memory.select(nav.state.books.book, nav.state.detailEntryBookId, nav.state.detailEntryNoteIds).id, "older");
nav.state.books.book = Object.assign({}, nav.state.books.book, { notes:[justWritten] });
assert.equal(memory.select(nav.state.books.book, nav.state.detailEntryBookId, nav.state.detailEntryNoteIds), null);

/* Leaving and entering again creates a fresh snapshot that includes the note. */
nav.openBook("book", "library");
assert.deepEqual(nav.state.detailEntryNoteIds, ["new"]);
assert.equal(memory.select(nav.state.books.book, nav.state.detailEntryBookId, nav.state.detailEntryNoteIds).id, "new");

/* Invalid timestamps never become a Reading Memory. */
var invalid = note("invalid", "not-a-date", "invalid", 10);
assert.equal(memory.select({ id:"book", notes:[invalid] }, "book", ["invalid"]), null);

/* The preview is additive: the original Book Log list and CRUD controls remain. */
assert.match(html, /notes\.map\(function\(n\)\{ return noteItem\(b\.id, n\); \}\)\.join\(""\)/);
assert.match(html, /data-editnote=/);
assert.match(html, /data-delnote=/);
assert.match(html, /data-savecompose=/);
assert.match(html, /readingMemoryHtml\(readingMemory\)/);

console.log("PASS Phase 2 Reading Memory tests");
