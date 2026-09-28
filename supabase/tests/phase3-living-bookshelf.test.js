"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

var livedSource = html.slice(
  html.indexOf("function isLivedBook("),
  html.indexOf("function libraryShelfHtml(")
);
var isLivedBook = new Function(livedSource + "; return isLivedBook;")();

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

assert.equal(isLivedBook(waiting), false, "registration alone stays Waiting");
assert.equal(isLivedBook(positive), true, "first positive page record becomes Lived");
assert.equal(isLivedBook(noteOnly), true, "a Book Log alone becomes Lived");
assert.equal(isLivedBook(completed), true, "completed books are Lived");
assert.equal(isLivedBook(correctionOnly), false, "negative/correction-only history stays Waiting");

var mixed = [completed, waiting, noteOnly, correctionOnly, positive].slice().sort(function(a, b){
  return new Date(a.createdAt) - new Date(b.createdAt);
});
assert.deepEqual(mixed.filter(isLivedBook).map(function(item){ return item.id; }), ["positive", "note-only", "completed"]);
assert.deepEqual(mixed.filter(function(item){ return !isLivedBook(item); }).map(function(item){ return item.id; }), ["waiting", "correction"]);

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
assert.match(html, /libraryShelfHtml\(lived, ROW_SIZE, latestBookId, bookPositions\)/);
assert.match(html, /libraryShelfHtml\(waiting, ROW_SIZE, latestBookId, bookPositions\)/);
assert.match(html, /읽어온 책/);
assert.match(html, /기다리는 책/);

console.log("PASS Phase 3 Living Bookshelf tests");
