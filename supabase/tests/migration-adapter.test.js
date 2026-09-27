"use strict";

var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");

var userId = "11111111-1111-4111-8111-111111111111";
var cloudIds = {
  "local-reading": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "local-done": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
};

function fixture(){
  return {
    books: [
      {
        id: "local-reading",
        title: "읽는 책",
        author: "저자 A",
        totalPages: 300,
        currentPage: 40,
        status: "reading",
        notes: [
          { id:"note-page", bookId:"local-reading", text:"페이지 흔적", page:80, createdAt:"2026-09-02T02:00:00.000Z" },
          { id:"note-null", bookId:"local-reading", text:"페이지 없는 흔적", page:null, createdAt:"2026-09-03T02:00:00.000Z" }
        ],
        pageLogs: [
          { id:"log-forward", date:"2026-09-01", prevPage:0, currentPage:80, delta:80, at:"2026-09-01T01:00:00.000Z" },
          { id:"log-backward", date:"2026-09-04", prevPage:80, currentPage:40, delta:-40, at:"2026-09-04T01:00:00.000Z" }
        ],
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-09-04T01:00:00.000Z",
        completedAt: null,
        lastPageLogDate: "2026-09-04",
        dayStartPage: 80,
        coverId: null,
        coverUrl: "https://example.com/remote-cover.jpg",
        isbn13: "9780000000001",
        publisher: "출판사",
        publishedAt: "2025-01-02",
        sourceProvider: "kakao",
        sourceId: "9780000000001"
      },
      {
        id: "local-done",
        title: "완독 책",
        author: "저자 B",
        totalPages: 120,
        currentPage: 120,
        status: "done",
        notes: [],
        pageLogs: [
          { id:"log-done", date:"2026-09-10", prevPage:50, currentPage:120, delta:70, at:"2026-09-10T03:00:00.000Z" }
        ],
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-09-11T05:00:00.000Z",
        completedAt: "2026-09-10T03:00:00.000Z",
        lastPageLogDate: "2026-09-10",
        dayStartPage: 50,
        coverId: "uploaded-cover-1",
        coverUrl: "blob:http://localhost:8000/uploaded-cover",
        completionReflection: {
          text: "완독 소감",
          createdAt: "2026-09-10T04:00:00.000Z",
          updatedAt: "2026-09-11T05:00:00.000Z"
        }
      }
    ],
    images: [
      { id:"uploaded-cover-1", blob:new Blob(["image"], { type:"image/png" }) },
      { id:"orphan-cover", blob:new Blob(["orphan"], { type:"image/png" }) }
    ]
  };
}

function clone(value){ return structuredClone(value); }
function expectValidation(mutator, label){
  var value = fixture();
  mutator(value);
  assert.throws(function(){ adapter.normalizeLocalSnapshot(value, userId); }, adapter.ValidationError, label);
}
function refs(){
  return {
    "local-reading": { cloudId:cloudIds["local-reading"], revision:1, userId:userId },
    "local-done": { cloudId:cloudIds["local-done"], revision:1, userId:userId }
  };
}

(async function(){
  var local = fixture();
  var normalized = adapter.normalizeLocalSnapshot(local, userId);
  assert.equal(normalized.books.length, 2);
  assert.equal(normalized.readingLogs.length, 3);
  assert.equal(normalized.bookNotes.length, 2);

  var remote = normalized.books.find(function(row){ return row.client_id === "local-reading"; });
  var uploaded = normalized.books.find(function(row){ return row.client_id === "local-done"; });
  assert.equal(remote.cover_source_url, "https://example.com/remote-cover.jpg");
  assert.equal(uploaded.cover_source_url, null);
  assert.deepEqual(normalized.excludedBlobCovers, [
    { bookClientId:"local-done", coverId:"uploaded-cover-1", reason:"local_blob_cover" }
  ]);
  assert.deepEqual(normalized.orphanImageIds, ["orphan-cover"]);

  assert.equal(normalized.readingLogs.find(function(row){ return row.client_id === "log-backward"; }).delta, -40);
  assert.equal(normalized.bookNotes.find(function(row){ return row.client_id === "note-page"; }).page, 80);
  assert.equal(normalized.bookNotes.find(function(row){ return row.client_id === "note-null"; }).page, null);
  assert.equal(normalized.bookNotes[0].updated_at, normalized.bookNotes[0].created_at);
  assert.equal(uploaded.completion_reflection_text, "완독 소감");
  assert.equal(uploaded.completed_at, "2026-09-10T03:00:00.000Z");
  assert.equal(remote.created_at, "2026-08-31T00:00:00.000Z");
  assert.equal(remote.updated_at, "2026-09-04T01:00:00.000Z");

  var rows = adapter.materializeCloudRows(normalized, refs());
  rows.readingLogs.forEach(function(row){
    var expected = row.client_id === "log-done" ? cloudIds["local-done"] : cloudIds["local-reading"];
    assert.equal(row.book_id, expected, "log parent mapping");
    assert.equal(Object.prototype.hasOwnProperty.call(row, "_book_client_id"), false);
  });
  rows.bookNotes.forEach(function(row){
    assert.equal(row.book_id, cloudIds["local-reading"], "note parent mapping");
  });

  var cloudBooks = rows.books.map(function(row){
    return Object.assign({
      id:cloudIds[row.client_id],
      revision:1
    }, row);
  });
  var reconstructed = adapter.reconstructLocalSnapshot(cloudBooks, rows.readingLogs, rows.bookNotes);
  var restoredReading = reconstructed.books.find(function(book){ return book.id === "local-reading"; });
  var restoredDone = reconstructed.books.find(function(book){ return book.id === "local-done"; });
  assert.deepEqual(restoredReading.pageLogs, local.books[0].pageLogs);
  assert.deepEqual(restoredReading.notes, local.books[0].notes);
  assert.equal(restoredReading.coverUrl, local.books[0].coverUrl);
  assert.deepEqual(restoredDone.completionReflection, local.books[1].completionReflection);
  assert.equal(restoredDone.completedAt, local.books[1].completedAt);
  assert.equal(restoredDone.coverId, null, "uploaded cover is intentionally not reconstructed");
  assert.equal(restoredDone.coverUrl, null, "uploaded cover is intentionally not reconstructed");

  var manifest = await adapter.createMigrationManifest(normalized);
  assert.equal(manifest.userId, userId);
  assert.deepEqual(manifest.counts, { books:2, readingLogs:3, bookNotes:2 });
  assert.deepEqual(manifest.bookClientIds, ["local-done", "local-reading"]);
  assert.deepEqual(manifest.readingLogClientIds, ["log-backward", "log-done", "log-forward"]);
  assert.deepEqual(manifest.noteClientIds, ["note-null", "note-page"]);
  assert.match(manifest.normalizedContentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.excludedBlobCovers.length, 1);
  assert.equal(manifest.normalizedContentHash, (await adapter.createMigrationManifest(normalized)).normalizedContentHash);

  expectValidation(function(value){ value.books[0].legacyMystery = true; }, "unknown book field");
  expectValidation(function(value){ value.books[1].id = value.books[0].id; }, "duplicate book ID");
  expectValidation(function(value){ value.books[1].pageLogs[0].id = value.books[0].pageLogs[0].id; }, "duplicate log ID");
  expectValidation(function(value){ value.books[1].notes.push(clone(value.books[0].notes[0])); }, "duplicate note ID");
  expectValidation(function(value){ value.books[0].status = "paused"; }, "invalid status");
  expectValidation(function(value){ value.books[0].currentPage = 301; }, "invalid page range");
  expectValidation(function(value){ value.books[0].pageLogs[0].delta = 79; }, "invalid delta");
  expectValidation(function(value){ value.books[0].notes[0].bookId = "local-done"; }, "note parent mismatch");
  expectValidation(function(value){ value.books[0].pageLogs[0].at = "not-a-date"; }, "invalid timestamp");
  expectValidation(function(value){ value.books[1].completionReflection.updatedAt = null; }, "invalid reflection timestamp");
  expectValidation(function(value){ value.books[1].coverId = "missing-image"; }, "missing image row");
  expectValidation(function(value){ value.books[0].coverUrl = "blob:http://localhost/no-id"; }, "unclassified blob URL");

  console.log("PASS migration-adapter pure tests");
})().catch(function(error){
  console.error("FAIL migration-adapter pure tests", error);
  process.exitCode = 1;
});
