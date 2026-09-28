"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

var sectionSource = html.slice(
  html.indexOf("function librarySectionForBook("),
  html.indexOf("function libraryShelfHtml(")
);
var librarySectionForBook = new Function(sectionSource + "; return librarySectionForBook;")();

function book(id, createdAt, overrides){
  return Object.assign({
    id:id,
    title:"책 " + id,
    author:"저자",
    createdAt:createdAt,
    totalPages:300,
    currentPage:0,
    status:"toread",
    completedAt:null,
    pageLogs:[],
    notes:[]
  }, overrides || {});
}

var waiting = book("waiting", "2026-09-01T00:00:00.000Z");
var positive = book("positive", "2026-09-02T00:00:00.000Z", {
  currentPage:10,
  status:"reading",
  pageLogs:[{ id:"log-positive", delta:10, date:"2026-09-02", at:"2026-09-02T01:00:00.000Z" }]
});
var noteOnly = book("note-only", "2026-09-03T00:00:00.000Z", {
  notes:[{ id:"note-1", text:"생각", page:null, createdAt:"2026-09-03T01:00:00.000Z" }]
});
var completed = book("completed", "2026-09-04T00:00:00.000Z", {
  status:"done",
  completedAt:"2026-09-05T00:00:00.000Z"
});
var correctionOnly = book("correction", "2026-09-05T00:00:00.000Z", {
  pageLogs:[{ id:"log-negative", delta:-5, date:"2026-09-05", at:"2026-09-05T01:00:00.000Z" }]
});
var correctedToZero = book("corrected-zero", "2026-09-06T00:00:00.000Z", {
  currentPage:0,
  status:"toread",
  pageLogs:[
    { id:"log-forward", delta:20, date:"2026-09-05", at:"2026-09-05T01:00:00.000Z" },
    { id:"log-back-zero", delta:-20, date:"2026-09-06", at:"2026-09-06T01:00:00.000Z" }
  ]
});
var correctedWithNote = book("corrected-note", "2026-09-07T00:00:00.000Z", {
  currentPage:0,
  status:"toread",
  pageLogs:correctedToZero.pageLogs,
  notes:[{ id:"note-after-correction", text:"남아 있는 생각", page:20, createdAt:"2026-09-05T02:00:00.000Z" }]
});

assert.equal(librarySectionForBook(waiting), "unread", "registration alone is unread");
assert.equal(librarySectionForBook(positive), "reading", "first positive page record is reading");
assert.equal(librarySectionForBook(noteOnly), "reading", "a Book Log alone is reading");
assert.equal(librarySectionForBook(completed), "read", "completed books are read");
assert.equal(librarySectionForBook(correctionOnly), "unread", "negative/correction-only history is unread");
assert.equal(librarySectionForBook(correctedToZero), "unread", "20 to 0 with no other trace returns to unread");
assert.equal(librarySectionForBook(correctedWithNote), "reading", "20 to 0 with an existing Book Log stays reading");

var doneWithProgressAndNote = book("done-priority", "2026-09-08T00:00:00.000Z", {
  currentPage:300,
  status:"done",
  completedAt:"2026-09-08T01:00:00.000Z",
  notes:[{ id:"done-note", text:"완독 기록", page:300, createdAt:"2026-09-08T01:00:00.000Z" }]
});
assert.equal(librarySectionForBook(doneWithProgressAndNote), "read", "completion has priority over reading signals");

var mixed = [completed, waiting, noteOnly, correctionOnly, positive].slice().sort(function(a, b){
  return new Date(a.createdAt) - new Date(b.createdAt);
});
assert.deepEqual(mixed.filter(function(item){ return librarySectionForBook(item) === "reading"; }).map(function(item){ return item.id; }), ["positive", "note-only"]);
assert.deepEqual(mixed.filter(function(item){ return librarySectionForBook(item) === "read"; }).map(function(item){ return item.id; }), ["completed"]);
assert.deepEqual(mixed.filter(function(item){ return librarySectionForBook(item) === "unread"; }).map(function(item){ return item.id; }), ["waiting", "correction"]);

/* Moving between areas keeps the book's position-derived visual identity. */
var shelfSource = html.slice(
  html.indexOf("function libraryShelfHtml("),
  html.indexOf("/* Reading history stays derived")
);
var capturedIndexes = [];
var libraryShelfHtml = new Function(
  "spineEl",
  shelfSource + "; return libraryShelfHtml;"
)(function(item, index){ capturedIndexes.push([item.id, index]); return item.id; });
var positions = { waiting:0, positive:1, "note-only":2, completed:3, correction:4 };
libraryShelfHtml([positive, noteOnly, completed], 2, "positive", positions);
libraryShelfHtml([waiting, correctionOnly], 2, "positive", positions);
assert.deepEqual(capturedIndexes, [
  ["positive", 1], ["note-only", 2], ["completed", 3],
  ["waiting", 0], ["correction", 4]
]);

/* The actual Library renderer keeps all established trace and navigation semantics. */
assert.match(html, /trace\.isLatest \? '<img class="library-rabbit"/);
assert.match(html, /trace\.returnCount \? '<span class="wear-trace/);
assert.match(html, /trace\.noteTabs \? '<span class="note-tabs/);
assert.match(html, /completed \? '<span class="completion-mark/);
assert.match(html, /spine-progress-fill/);
assert.match(html, /data-open="' \+ b\.id \+ '" data-open-from="library"/);
assert.match(html, /var latestBookId = latestPositiveBookId\(\)/);
assert.match(html, /libraryShelfHtml\(reading, ROW_SIZE, latestBookId, bookPositions\)/);
assert.match(html, /libraryShelfHtml\(read, ROW_SIZE, latestBookId, bookPositions\)/);
assert.match(html, /libraryShelfHtml\(unread, ROW_SIZE, latestBookId, bookPositions\)/);
assert.match(html, /읽고 있는 책/);
assert.match(html, /읽은 책/);
assert.match(html, /안 읽은 책/);
assert.doesNotMatch(html, /읽어온 책|기다리는 책/);

console.log("PASS Phase 3 Living Bookshelf tests");
