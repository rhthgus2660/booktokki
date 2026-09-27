"use strict";

var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");
var restore = require("../cloud-restore.js");

var userId = "11111111-1111-4111-8111-111111111111";
var serverCreatedAt = "2026-09-24T00:00:00.000Z";

function localSource(){
  return { books:[
    {
      id:"book-reading", title:"읽는 책", author:"저자 A", totalPages:200, currentPage:40, status:"reading",
      notes:[
        { id:"note-page", bookId:"book-reading", text:"페이지 흔적", page:40, createdAt:"2026-09-20T04:00:00.000Z" },
        { id:"note-null", bookId:"book-reading", text:"일반 흔적", page:null, createdAt:"2026-09-21T04:00:00.000Z" }
      ],
      pageLogs:[
        { id:"log-positive", date:"2026-09-20", prevPage:0, currentPage:80, delta:80, at:"2026-09-20T03:00:00.000Z" },
        { id:"log-negative", date:"2026-09-21", prevPage:80, currentPage:40, delta:-40, at:"2026-09-21T03:00:00.000Z" }
      ],
      createdAt:"2026-09-19T00:00:00.000Z", updatedAt:"2026-09-21T04:00:00.000Z",
      completedAt:null, lastPageLogDate:"2026-09-21", dayStartPage:80,
      coverId:null, coverUrl:"https://example.com/remote.jpg"
    },
    {
      id:"book-done", title:"완독 책", author:"저자 B", totalPages:100, currentPage:100, status:"done",
      notes:[], pageLogs:[{ id:"log-done", date:"2026-09-22", prevPage:50, currentPage:100, delta:50, at:"2026-09-22T03:00:00.000Z" }],
      createdAt:"2026-09-18T00:00:00.000Z", updatedAt:"2026-09-22T05:00:00.000Z",
      completedAt:"2026-09-22T03:00:00.000Z", lastPageLogDate:"2026-09-22", dayStartPage:50,
      coverId:null, coverUrl:null,
      completionReflection:{ text:"완독 소감", createdAt:"2026-09-22T04:00:00.000Z", updatedAt:"2026-09-22T05:00:00.000Z" }
    }
  ], images:[] };
}
function clone(value){ return structuredClone(value); }

async function cloudFixture(){
  var normalized = adapter.normalizeLocalSnapshot(localSource(), userId);
  var refs = {};
  normalized.books.forEach(function(book){ refs[book.client_id] = { cloudId:"cloud-" + book.client_id, revision:1, userId:userId }; });
  var rows = adapter.materializeCloudRows(normalized, refs);
  return {
    books:rows.books.map(function(row){ return Object.assign({ id:refs[row.client_id].cloudId, revision:1 }, row); }),
    readingLogs:rows.readingLogs.map(function(row){ return Object.assign({ id:"cloud-" + row.client_id, created_at:serverCreatedAt }, row); }),
    bookNotes:rows.bookNotes.map(function(row){ return Object.assign({ id:"cloud-" + row.client_id }, row); })
  };
}

function memoryDatabase(initialBooks, initialImages, behavior){
  behavior = behavior || {};
  var committedBooks = clone(initialBooks || []);
  var committedImages = clone(initialImages || []);
  var writeTransactions = 0;
  var putCount = 0;
  function request(work){
    var req = {};
    queueMicrotask(function(){
      try { req.result = work(); if (req.onsuccess) req.onsuccess(); }
      catch (error){ req.error = error; if (req.onerror) req.onerror(); }
    });
    return req;
  }
  var database = {
    transaction:function(names, mode){
      var tx = { oncomplete:null, onabort:null, onerror:null, error:null };
      var stagingBooks = clone(committedBooks);
      var aborted = false;
      if (mode === "readwrite") writeTransactions += 1;
      tx.abort = function(){
        if (aborted) return;
        aborted = true;
        tx.error = tx.error || new Error("transaction aborted");
        queueMicrotask(function(){ if (tx.onabort) tx.onabort(); });
      };
      tx.objectStore = function(name){
        return {
          getAll:function(){ return request(function(){ return clone(name === "books" ? stagingBooks : committedImages); }); },
          put:function(value){
            if (mode !== "readwrite") throw new Error("put in readonly transaction");
            putCount += 1;
            if (behavior.failPutAt === putCount){
              tx.error = new Error("injected put failure");
              queueMicrotask(function(){ tx.abort(); });
              return request(function(){ throw tx.error; });
            }
            var index = stagingBooks.findIndex(function(book){ return book.id === value.id; });
            if (index === -1) stagingBooks.push(clone(value));
            else stagingBooks[index] = clone(value);
            return request(function(){ return value.id; });
          },
          delete:function(){ throw new Error("delete must not be called"); },
          clear:function(){ throw new Error("clear must not be called"); }
        };
      };
      setTimeout(function(){
        if (aborted) return;
        if (mode === "readwrite") committedBooks = stagingBooks;
        if (tx.oncomplete) tx.oncomplete();
      }, 0);
      return tx;
    },
    inspect:function(){ return { books:clone(committedBooks), images:clone(committedImages), writeTransactions:writeTransactions, putCount:putCount }; }
  };
  return database;
}

function selectClient(cloud, calls){
  var rows = { books:cloud.books, reading_logs:cloud.readingLogs, book_notes:cloud.bookNotes };
  return {
    from:function(table){
      calls.push({ method:"from", table:table });
      return {
        select:function(){
          calls.push({ method:"select", table:table });
          return { eq:function(){
            calls.push({ method:"eq", table:table });
            return { order:function(){ calls.push({ method:"order", table:table }); return Promise.resolve({ data:clone(rows[table]), error:null }); } };
          } };
        },
        insert:function(){ throw new Error("Cloud INSERT must not be called"); },
        update:function(){ throw new Error("Cloud UPDATE must not be called"); },
        upsert:function(){ throw new Error("Cloud UPSERT must not be called"); },
        delete:function(){ throw new Error("Cloud DELETE must not be called"); }
      };
    },
    rpc:function(){ throw new Error("Cloud RPC must not be called"); }
  };
}

(async function(){
  var cloud = await cloudFixture();

  /* A/H/I/J/K/L. CLOUD_ONLY reconstructs all supported data; coverless Blob source remains absent. */
  var database = memoryDatabase([], []);
  var calls = [];
  var result = await restore.executeCloudRestore({
    database:database, client:selectClient(cloud, calls), userId:userId,
    journal:{ excludedBlobCovers:[{ bookClientId:"book-done", coverId:"old-local-blob", reason:"local_blob_cover" }] }
  });
  assert.equal(result.success, true);
  assert.equal(result.stateBefore, restore.STATES.CLOUD_ONLY);
  assert.equal(result.verificationPassed, true);
  assert.equal(result.cloudUnchanged, true);
  assert.deepEqual(result.restored, { books:2, readingLogs:3, bookNotes:2 });
  assert.equal(result.excludedUnavailableAssets.blobCovers.length, 1);
  var stored = database.inspect();
  var reading = stored.books.find(function(book){ return book.id === "book-reading"; });
  var done = stored.books.find(function(book){ return book.id === "book-done"; });
  assert.equal(reading.coverUrl, "https://example.com/remote.jpg");
  assert.equal(reading.pageLogs.find(function(log){ return log.id === "log-negative"; }).delta, -40);
  assert.equal(reading.notes.find(function(note){ return note.id === "note-page"; }).page, 40);
  assert.equal(reading.notes.find(function(note){ return note.id === "note-null"; }).page, null);
  assert.deepEqual(done.completionReflection, localSource().books[1].completionReflection);
  assert.equal(done.coverId, null);
  assert.equal(done.coverUrl, null);
  assert.equal(calls.some(function(call){ return !["from", "select", "eq", "order"].includes(call.method); }), false);

  /* M. Re-run sees Local + Cloud and performs zero additional writes. */
  var writesBefore = database.inspect().writeTransactions;
  var rerun = await restore.executeCloudRestore({ database:database, client:selectClient(cloud, []), userId:userId });
  assert.equal(rerun.success, false);
  assert.equal(rerun.blocked, true);
  assert.equal(rerun.stateBefore, restore.STATES.CONFLICT);
  assert.equal(rerun.localWrites, 0);
  assert.equal(database.inspect().writeTransactions, writesBefore);

  /* B. EMPTY writes nothing. */
  var emptyDb = memoryDatabase([], []);
  var empty = await restore.executeCloudRestore({
    database:emptyDb, client:selectClient({ books:[], readingLogs:[], bookNotes:[] }, []), userId:userId
  });
  assert.equal(empty.stateBefore, restore.STATES.EMPTY);
  assert.equal(empty.localWrites, 0);
  assert.equal(emptyDb.inspect().writeTransactions, 0);

  /* C. Existing Local and Cloud conflict, no write. */
  var conflictDb = memoryDatabase([localSource().books[0]], []);
  var conflict = await restore.executeCloudRestore({ database:conflictDb, client:selectClient(cloud, []), userId:userId });
  assert.equal(conflict.stateBefore, restore.STATES.CONFLICT);
  assert.equal(conflict.localWrites, 0);
  assert.equal(conflictDb.inspect().writeTransactions, 0);

  /* Local orphan images do not block an otherwise empty-book restore and remain untouched. */
  var orphanImage = { id:"orphan", blob:new Blob(["orphan"]) };
  var orphanDb = memoryDatabase([], [orphanImage]);
  var orphan = await restore.executeCloudRestore({ database:orphanDb, client:selectClient(cloud, []), userId:userId });
  assert.equal(orphan.success, true);
  assert.equal(orphanDb.inspect().images.length, 1);

  /* D/F. Invalid orphan parent and duplicate client IDs write nothing. */
  var badParent = clone(cloud);
  badParent.readingLogs[0].book_id = "missing-parent";
  var badParentDb = memoryDatabase([], []);
  var badParentResult = await restore.executeCloudRestore({ database:badParentDb, client:selectClient(badParent, []), userId:userId });
  assert.equal(badParentResult.stateBefore, restore.STATES.INVALID_CLOUD_STATE);
  assert.equal(badParentDb.inspect().writeTransactions, 0);
  var duplicate = clone(cloud);
  duplicate.books.push(clone(duplicate.books[0]));
  var duplicateDb = memoryDatabase([], []);
  var duplicateResult = await restore.executeCloudRestore({ database:duplicateDb, client:selectClient(duplicate, []), userId:userId });
  assert.equal(duplicateResult.stateBefore, restore.STATES.INVALID_CLOUD_STATE);
  assert.equal(duplicateDb.inspect().writeTransactions, 0);

  /* E. A row for another user is rejected. */
  var wrongUser = clone(cloud);
  wrongUser.books[0].user_id = "22222222-2222-4222-8222-222222222222";
  var wrongUserDb = memoryDatabase([], []);
  var wrongUserResult = await restore.executeCloudRestore({ database:wrongUserDb, client:selectClient(wrongUser, []), userId:userId });
  assert.equal(wrongUserResult.stateBefore, restore.STATES.INVALID_CLOUD_STATE);
  assert.equal(wrongUserDb.inspect().writeTransactions, 0);

  /* G. An IndexedDB failure aborts the whole transaction and leaves Local empty. */
  var failingDb = memoryDatabase([], [], { failPutAt:2 });
  var failed = await restore.executeCloudRestore({ database:failingDb, client:selectClient(cloud, []), userId:userId });
  assert.equal(failed.success, false);
  assert.equal(failed.localWriteCompleted, false);
  assert.equal(failingDb.inspect().books.length, 0);

  console.log("PASS cloud restore tests");
})().catch(function(error){
  console.error("FAIL cloud restore tests", error);
  process.exitCode = 1;
});
