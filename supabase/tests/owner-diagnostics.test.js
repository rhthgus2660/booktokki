"use strict";

var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");
var diagnostics = require("../../owner-diagnostics.js");

var USER_ID = "11111111-1111-4111-8111-111111111111";

function book(id, withChildren){
  return {
    id:id, title:"diagnostic fixture", author:"fixture author", totalPages:100,
    currentPage:withChildren ? 20 : 0, status:withChildren ? "reading" : "toread",
    notes:withChildren ? [{ id:"note-1", bookId:id, text:"fixture note", page:20, createdAt:"2026-09-27T02:00:00.000Z" }] : [],
    pageLogs:withChildren ? [{ id:"log-1", date:"2026-09-27", prevPage:0, currentPage:20, delta:20, at:"2026-09-27T01:00:00.000Z" }] : [],
    createdAt:"2026-09-26T00:00:00.000Z", updatedAt:withChildren ? "2026-09-27T02:00:00.000Z" : "2026-09-26T00:00:00.000Z",
    completedAt:null, lastPageLogDate:withChildren ? "2026-09-27" : null,
    dayStartPage:withChildren ? 0 : null, coverId:null, coverUrl:null
  };
}

function localFixture(){ return { books:[book("book-shared", true), book("book-local-only", false)], images:[] }; }
function clone(value){ return structuredClone(value); }

async function cloudSubset(local){
  var normalized = adapter.normalizeLocalSnapshot(local, USER_ID);
  var refs = {
    "book-shared":{ cloudId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision:3, userId:USER_ID },
    "book-local-only":{ cloudId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revision:1, userId:USER_ID }
  };
  var rows = adapter.materializeCloudRows(normalized, refs);
  return {
    books:rows.books.filter(function(row){ return row.client_id === "book-shared"; }).map(function(row){
      var copy = Object.assign({ id:refs[row.client_id].cloudId, revision:3 }, row);
      copy.created_at = copy.created_at.replace("Z", "+00:00");
      copy.updated_at = copy.updated_at.replace("Z", "+00:00");
      return copy;
    }),
    readingLogs:rows.readingLogs.filter(function(row){ return row._book_client_id !== "book-local-only"; }).map(function(row){
      var copy = Object.assign({ id:"cloud-log-1", created_at:row.recorded_at }, row);
      delete copy._book_client_id;
      copy.recorded_at = copy.recorded_at.replace("Z", "+00:00");
      return copy;
    }),
    bookNotes:rows.bookNotes.filter(function(row){ return row._book_client_id !== "book-local-only"; }).map(function(row){
      var copy = Object.assign({ id:"cloud-note-1" }, row);
      delete copy._book_client_id;
      copy.created_at = copy.created_at.replace("Z", "+00:00");
      copy.updated_at = "2026-09-27T03:00:00+00:00"; // Cloud-only edit timestamp is not in Local note shape.
      return copy;
    })
  };
}

function readonlyDatabase(snapshot, counters){
  return { transaction:function(names, mode){
    counters.transactions++;
    assert.deepEqual(names, ["books", "images"]);
    assert.equal(mode, "readonly");
    var tx = {};
    tx.objectStore = function(name){
      return { getAll:function(){
        var request = { result:clone(snapshot[name]) };
        setTimeout(function(){ request.onsuccess(); tx.oncomplete && tx.oncomplete(); });
        return request;
      } };
    };
    return tx;
  } };
}

function selectOnlyClient(snapshot, counters){
  return { from:function(table){
    assert.ok(["books", "reading_logs", "book_notes"].includes(table));
    counters.selects++;
    return {
      select:function(columns){
        assert.equal(columns, "*");
        return { eq:function(column, value){
          assert.equal(column, "user_id");
          assert.equal(value, USER_ID);
          return { order:function(){
            var key = table === "reading_logs" ? "readingLogs" : (table === "book_notes" ? "bookNotes" : "books");
            return Promise.resolve({ data:clone(snapshot[key]), error:null });
          } };
        } };
      },
      insert:function(){ throw new Error("diagnostic must not INSERT"); },
      update:function(){ throw new Error("diagnostic must not UPDATE"); },
      delete:function(){ throw new Error("diagnostic must not DELETE"); },
      upsert:function(){ throw new Error("diagnostic must not UPSERT"); }
    };
  }, rpc:function(){ throw new Error("diagnostic must not call RPC"); } };
}

(async function(){
  var local = localFixture();
  var cloud = await cloudSubset(local);

  var safe = await diagnostics.compareSnapshots({ localSnapshot:local, cloudSnapshot:cloud, userId:USER_ID, ownerState:"MISSING" });
  assert.deepEqual(safe, {
    state:"SAFE_TO_ADOPT", matchedBooks:1, cloudBooks:1,
    matchedReadingLogs:1, cloudReadingLogs:1,
    matchedBookNotes:1, cloudBookNotes:1,
    localOnlyBooks:1, conflicts:0
  });

  var conflictCloud = clone(cloud);
  conflictCloud.books[0].current_page = 21;
  var conflict = await diagnostics.compareSnapshots({ localSnapshot:local, cloudSnapshot:conflictCloud, userId:USER_ID, ownerState:"MISSING" });
  assert.equal(conflict.state, "CONFLICT");
  assert.equal(conflict.conflicts, 1);

  var unknownCloud = clone(cloud);
  unknownCloud.books[0].client_id = "unknown-cloud-book";
  unknownCloud.readingLogs[0].client_id = "unknown-cloud-log";
  unknownCloud.bookNotes[0].client_id = "unknown-cloud-note";
  var unverified = await diagnostics.compareSnapshots({ localSnapshot:local, cloudSnapshot:unknownCloud, userId:USER_ID, ownerState:"MISSING" });
  assert.equal(unverified.state, "UNVERIFIED");
  assert.equal(unverified.conflicts, 0);

  var wrongOwnerState = await diagnostics.compareSnapshots({ localSnapshot:local, cloudSnapshot:cloud, userId:USER_ID, ownerState:"MISMATCH" });
  assert.equal(wrongOwnerState.state, "UNVERIFIED");

  var counters = { transactions:0, selects:0 };
  var runtime = await diagnostics.runReadOnlyComparison({
    database:readonlyDatabase(local, counters),
    client:selectOnlyClient(cloud, counters),
    userId:USER_ID,
    ownerState:"MISSING"
  });
  assert.equal(runtime.state, "SAFE_TO_ADOPT");
  assert.equal(counters.transactions, 1);
  assert.equal(counters.selects, 3);

  console.log("PASS owner diagnostics read-only comparison tests");
})().catch(function(error){ console.error("FAIL owner diagnostics tests", error); process.exitCode = 1; });
