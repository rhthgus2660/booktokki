"use strict";

var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");
var dryRun = require("../migration-dry-run.js");

var userId = "11111111-1111-4111-8111-111111111111";
var now = "2026-09-24T00:00:00.000Z";

function localFixture(){
  return {
    books:[{
      id:"book-local-1", title:"테스트 책", author:"저자", totalPages:200, currentPage:30, status:"reading",
      notes:[{ id:"note-1", bookId:"book-local-1", text:"흔적", page:30, createdAt:"2026-09-22T02:00:00.000Z" }],
      pageLogs:[{ id:"log-1", date:"2026-09-22", prevPage:0, currentPage:30, delta:30, at:"2026-09-22T01:00:00.000Z" }],
      createdAt:"2026-09-20T00:00:00.000Z", updatedAt:"2026-09-22T02:00:00.000Z",
      completedAt:null, lastPageLogDate:"2026-09-22", dayStartPage:0,
      coverId:"image-1", coverUrl:"blob:http://localhost/cover"
    }],
    images:[
      { id:"image-1", blob:new Blob(["cover"]) },
      { id:"orphan-image", blob:new Blob(["orphan"]) }
    ]
  };
}
function emptyCloud(){ return { books:[], readingLogs:[], bookNotes:[] }; }
function clone(value){ return structuredClone(value); }

async function prepared(){
  var local = localFixture();
  var normalized = adapter.normalizeLocalSnapshot(local, userId);
  var manifest = await adapter.createMigrationManifest(normalized);
  var refs = { "book-local-1": { cloudId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision:1, userId:userId } };
  var rows = adapter.materializeCloudRows(normalized, refs);
  var books = rows.books.map(function(row){
    return Object.assign({ id:refs[row.client_id].cloudId, revision:1 }, row);
  });
  return { local:local, normalized:normalized, manifest:manifest, rows:rows, cloud:{ books:books, readingLogs:rows.readingLogs, bookNotes:rows.bookNotes } };
}
function journal(manifest){
  return dryRun.createMigrationJournal(manifest, "in_progress", { startedAt:now, updatedAt:now });
}
function state(input){ return dryRun.detectMigrationState(input); }

function fakeReadonlyDb(books, images, modes){
  function request(value){
    var req = {};
    queueMicrotask(function(){ req.result = value; if (req.onsuccess) req.onsuccess(); });
    return req;
  }
  return {
    transaction:function(names, mode){
      modes.push({ names:names.slice(), mode:mode });
      assert.equal(mode, "readonly");
      return {
        objectStore:function(name){
          return {
            getAll:function(){ return request(name === "books" ? books : images); },
            put:function(){ throw new Error("write called"); },
            delete:function(){ throw new Error("write called"); },
            clear:function(){ throw new Error("write called"); }
          };
        },
        onabort:null,
        onerror:null
      };
    }
  };
}

function fakeSelectClient(snapshot, calls){
  var tableRows = { books:snapshot.books, reading_logs:snapshot.readingLogs, book_notes:snapshot.bookNotes };
  return {
    from:function(table){
      calls.push({ method:"from", table:table });
      return {
        select:function(columns){
          calls.push({ method:"select", table:table, columns:columns });
          return {
            eq:function(column, value){
              calls.push({ method:"eq", table:table, column:column, value:value });
              return {
                order:function(columnName, options){
                  calls.push({ method:"order", table:table, column:columnName, options:options });
                  return Promise.resolve({ data:clone(tableRows[table]), error:null });
                }
              };
            }
          };
        },
        insert:function(){ throw new Error("write called"); },
        update:function(){ throw new Error("write called"); },
        upsert:function(){ throw new Error("write called"); },
        delete:function(){ throw new Error("write called"); }
      };
    },
    rpc:function(){ throw new Error("RPC called"); }
  };
}

(async function(){
  var p = await prepared();
  var base = { normalized:p.normalized, manifest:p.manifest, journal:null };

  assert.equal(state(Object.assign({}, base, { localBookCount:0, cloudSnapshot:emptyCloud() })), dryRun.STATES.EMPTY);
  assert.equal(state(Object.assign({}, base, { localBookCount:1, cloudSnapshot:emptyCloud() })), dryRun.STATES.LOCAL_ONLY);
  assert.equal(state(Object.assign({}, base, { localBookCount:0, cloudSnapshot:p.cloud })), dryRun.STATES.CLOUD_ONLY);
  assert.equal(state(Object.assign({}, base, { localBookCount:1, cloudSnapshot:p.cloud })), dryRun.STATES.CONFLICT);
  assert.equal(state(Object.assign({}, base, {
    localBookCount:0,
    cloudSnapshot:{ books:[], readingLogs:[clone(p.cloud.readingLogs[0])], bookNotes:[] }
  })), dryRun.STATES.INVALID_CLOUD_STATE);

  var partial = { books:[clone(p.cloud.books[0])], readingLogs:[clone(p.cloud.readingLogs[0])], bookNotes:[] };
  assert.equal(state(Object.assign({}, base, {
    localBookCount:1, cloudSnapshot:partial, journal:journal(p.manifest)
  })), dryRun.STATES.RESUMABLE_MIGRATION);

  var wrongHash = journal(p.manifest);
  wrongHash.manifestHash = "sha256:" + "0".repeat(64);
  assert.equal(state(Object.assign({}, base, {
    localBookCount:1, cloudSnapshot:partial, journal:wrongHash
  })), dryRun.STATES.CONFLICT);

  var unexpected = clone(partial);
  unexpected.books[0].client_id = "unexpected-cloud-book";
  assert.equal(state(Object.assign({}, base, {
    localBookCount:1, cloudSnapshot:unexpected, journal:journal(p.manifest)
  })), dryRun.STATES.CONFLICT);

  var mismatched = clone(partial);
  mismatched.books[0].title = "다른 제목";
  assert.equal(state(Object.assign({}, base, {
    localBookCount:1, cloudSnapshot:mismatched, journal:journal(p.manifest)
  })), dryRun.STATES.CONFLICT);

  var badParent = clone(partial);
  badParent.readingLogs[0].book_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.equal(state(Object.assign({}, base, {
    localBookCount:1, cloudSnapshot:badParent, journal:journal(p.manifest)
  })), dryRun.STATES.INVALID_CLOUD_STATE);

  var localOnlyReport = await dryRun.buildMigrationDryRunReport({
    localSnapshot:p.local, cloudSnapshot:emptyCloud(), userId:userId, journal:null
  });
  assert.equal(localOnlyReport.state, dryRun.STATES.LOCAL_ONLY);
  assert.equal(localOnlyReport.canMigrate, true);
  assert.deepEqual(localOnlyReport.wouldCreate, { books:1, readingLogs:1, bookNotes:1 });
  assert.equal(localOnlyReport.excluded.blobCovers.length, 1);
  assert.deepEqual(localOnlyReport.excluded.orphanImageIds, ["orphan-image"]);

  var conflictReport = await dryRun.buildMigrationDryRunReport({
    localSnapshot:p.local, cloudSnapshot:p.cloud, userId:userId, journal:null
  });
  assert.equal(conflictReport.state, dryRun.STATES.CONFLICT);
  assert.equal(conflictReport.canMigrate, false);
  assert.deepEqual(conflictReport.wouldCreate, { books:0, readingLogs:0, bookNotes:0 });

  var unknown = localFixture();
  unknown.books[0].unknownLegacyField = true;
  var invalidReport = await dryRun.buildMigrationDryRunReport({
    localSnapshot:unknown, cloudSnapshot:emptyCloud(), userId:userId, journal:null
  });
  assert.equal(invalidReport.state, dryRun.STATES.VALIDATION_FAILED);
  assert.equal(invalidReport.canMigrate, false);
  assert.equal(invalidReport.validation.passed, false);

  var modes = [];
  var localRead = await dryRun.readLocalMigrationSnapshot(fakeReadonlyDb(p.local.books, p.local.images, modes));
  assert.equal(modes.length, 1);
  assert.equal(modes[0].mode, "readonly");
  assert.equal(localRead.books.length, 1);

  var calls = [];
  var cloudRead = await dryRun.readCloudMigrationSnapshot(fakeSelectClient(p.cloud, calls), userId);
  assert.equal(cloudRead.books.length, 1);
  assert.deepEqual(Array.from(new Set(calls.map(function(call){ return call.method; }))).sort(), ["eq", "from", "order", "select"]);

  var storageReads = 0;
  var savedJournal = journal(p.manifest);
  var storage = {
    getItem:function(key){ storageReads += 1; assert.equal(key, dryRun.migrationJournalKey(userId)); return JSON.stringify(savedJournal); },
    setItem:function(){ throw new Error("journal write called"); }
  };
  assert.equal(dryRun.readMigrationJournal(storage, userId).status, "in_progress");
  assert.equal(storageReads, 1);

  console.log("PASS migration state detector and dry-run tests");
})().catch(function(error){
  console.error("FAIL migration state detector and dry-run tests", error);
  process.exitCode = 1;
});
