"use strict";

var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");
var dryRun = require("../migration-dry-run.js");
var executor = require("../migration-executor.js");

var userId = "11111111-1111-4111-8111-111111111111";
var fixedNow = "2026-09-24T12:00:00.000Z";

function localFixture(){
  return {
    books:[
      {
        id:"book-a", title:"책 A", author:"저자 A", totalPages:200, currentPage:30, status:"reading",
        notes:[{ id:"note-a", bookId:"book-a", text:"A 흔적", page:30, createdAt:"2026-09-21T03:00:00.000Z" }],
        pageLogs:[{ id:"log-a", date:"2026-09-21", prevPage:0, currentPage:30, delta:30, at:"2026-09-21T02:00:00.000Z" }],
        createdAt:"2026-09-20T00:00:00.000Z", updatedAt:"2026-09-21T03:00:00.000Z",
        completedAt:null, lastPageLogDate:"2026-09-21", dayStartPage:0,
        coverId:null, coverUrl:"https://example.com/a.jpg"
      },
      {
        id:"book-b", title:"책 B", author:"저자 B", totalPages:100, currentPage:100, status:"done",
        notes:[{ id:"note-b", bookId:"book-b", text:"B 흔적", page:null, createdAt:"2026-09-23T03:00:00.000Z" }],
        pageLogs:[{ id:"log-b", date:"2026-09-23", prevPage:40, currentPage:100, delta:60, at:"2026-09-23T02:00:00.000Z" }],
        createdAt:"2026-09-19T00:00:00.000Z", updatedAt:"2026-09-23T04:00:00.000Z",
        completedAt:"2026-09-23T02:00:00.000Z", lastPageLogDate:"2026-09-23", dayStartPage:40,
        coverId:"image-b", coverUrl:"blob:http://localhost/b",
        completionReflection:{ text:"B 완독", createdAt:"2026-09-23T03:30:00.000Z", updatedAt:"2026-09-23T04:00:00.000Z" }
      }
    ],
    images:[{ id:"image-b", blob:new Blob(["cover"]) }]
  };
}
function clone(value){ return structuredClone(value); }
function memoryStorage(){
  var data = {};
  return {
    getItem:function(key){ return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem:function(key, value){ data[key] = String(value); },
    dump:function(){ return clone(data); }
  };
}
function journalFrom(storage){
  return JSON.parse(storage.getItem(dryRun.migrationJournalKey(userId)));
}

function mockClient(initial, behavior){
  behavior = behavior || {};
  var rows = {
    books:clone(initial && initial.books || []),
    reading_logs:clone(initial && initial.readingLogs || []),
    book_notes:clone(initial && initial.bookNotes || [])
  };
  var writes = [];
  var attempts = { books:0, reading_logs:0, book_notes:0 };
  var selects = 0;
  function cloudView(table){
    var output = clone(rows[table]);
    if (behavior.corruptVerification && writes.length >= behavior.corruptVerification.afterWrites && table === "books" && output[0]){
      output[0].title = "검증 불일치";
    }
    return output;
  }
  function insertedRow(table, input){
    var row = clone(input);
    row.id = "cloud-" + table + "-" + input.client_id;
    if (table === "books") row.revision = 1;
    if (table === "reading_logs") row.created_at = fixedNow;
    return row;
  }
  return {
    from:function(table){
      return {
        select:function(){
          return {
            eq:function(){
              return {
                order:function(){ selects += 1; return Promise.resolve({ data:cloudView(table), error:null }); }
              };
            }
          };
        },
        insert:function(input){
          attempts[table] += 1;
          return {
            select:function(){
              return {
                single:function(){
                  if (behavior.fail && behavior.fail.table === table && behavior.fail.attempt === attempts[table]){
                    return Promise.resolve({ data:null, error:{ name:"NetworkError", message:"injected failure" } });
                  }
                  if (rows[table].some(function(row){ return row.user_id === input.user_id && row.client_id === input.client_id; })){
                    return Promise.resolve({ data:null, error:{ code:"23505", status:409, message:"duplicate" } });
                  }
                  var row = insertedRow(table, input);
                  rows[table].push(row);
                  writes.push({ table:table, clientId:input.client_id });
                  return Promise.resolve({ data:clone(row), error:null });
                }
              };
            }
          };
        },
        update:function(){ throw new Error("UPDATE must not be called"); },
        upsert:function(){ throw new Error("UPSERT must not be called"); },
        delete:function(){ throw new Error("DELETE must not be called"); }
      };
    },
    rpc:function(){ throw new Error("RPC must not be called"); },
    inspect:function(){
      return {
        cloud:{ books:clone(rows.books), readingLogs:clone(rows.reading_logs), bookNotes:clone(rows.book_notes) },
        writes:clone(writes), attempts:clone(attempts), selects:selects
      };
    },
    clearFailure:function(){ behavior.fail = null; }
  };
}

function options(client, storage, local){
  return { client:client, storage:storage, localSnapshot:local, userId:userId, now:function(){ return fixedNow; } };
}

async function normalizedCloud(local){
  var normalized = adapter.normalizeLocalSnapshot(local, userId);
  var refs = {};
  normalized.books.forEach(function(book){ refs[book.client_id] = { cloudId:"cloud-books-" + book.client_id, revision:1, userId:userId }; });
  var materialized = adapter.materializeCloudRows(normalized, refs);
  return {
    normalized:normalized,
    manifest:await adapter.createMigrationManifest(normalized),
    cloud:{
      books:materialized.books.map(function(row){ return Object.assign({ id:refs[row.client_id].cloudId, revision:1 }, row); }),
      readingLogs:materialized.readingLogs.map(function(row){ return Object.assign({ id:"cloud-reading_logs-" + row.client_id, created_at:fixedNow }, row); }),
      bookNotes:materialized.bookNotes.map(function(row){ return Object.assign({ id:"cloud-book_notes-" + row.client_id }, row); })
    }
  };
}

(async function(){
  /* A. Normal LOCAL_ONLY migration and complete journal. */
  var local = localFixture();
  var original = clone(local);
  var client = mockClient();
  var storage = memoryStorage();
  var result = await executor.executeMigration(options(client, storage, local));
  assert.equal(result.success, true);
  assert.equal(result.resumed, false);
  assert.deepEqual(result.written, { books:2, readingLogs:2, bookNotes:2 });
  assert.equal(result.verificationPassed, true);
  assert.equal(result.journalStatus, "complete");
  assert.equal(journalFrom(storage).status, "complete");
  assert.deepEqual(local, original, "Local snapshot remains unchanged");

  /* I. Re-running a completed migration writes nothing. */
  var writesBefore = client.inspect().writes.length;
  var second = await executor.executeMigration(options(client, storage, local));
  assert.equal(second.success, true);
  assert.equal(second.alreadyComplete, true);
  assert.deepEqual(second.written, { books:0, readingLogs:0, bookNotes:0 });
  assert.equal(client.inspect().writes.length, writesBefore);

  /* B. Validation failure writes nothing and creates no journal. */
  var invalidLocal = localFixture();
  invalidLocal.books[0].unknownLegacy = true;
  var invalidClient = mockClient();
  var invalidStorage = memoryStorage();
  var invalidResult = await executor.executeMigration(options(invalidClient, invalidStorage, invalidLocal));
  assert.equal(invalidResult.success, false);
  assert.equal(invalidResult.blocked, true);
  assert.equal(invalidClient.inspect().writes.length, 0);
  assert.equal(invalidStorage.getItem(dryRun.migrationJournalKey(userId)), null);

  /* C/G. Cloud conflict or differing same client ID writes nothing. */
  var prepared = await normalizedCloud(localFixture());
  var conflictingCloud = { books:[clone(prepared.cloud.books[0])], readingLogs:[], bookNotes:[] };
  conflictingCloud.books[0].title = "다른 Cloud 제목";
  var conflictClient = mockClient(conflictingCloud);
  var conflictStorage = memoryStorage();
  var conflict = await executor.executeMigration(options(conflictClient, conflictStorage, localFixture()));
  assert.equal(conflict.success, false);
  assert.equal(conflict.blocked, true);
  assert.equal(conflictClient.inspect().writes.length, 0);

  /* D/E. A parent insert failure keeps an in-progress journal, then resumes only missing rows. */
  var partialClient = mockClient(null, { fail:{ table:"books", attempt:2 } });
  var partialStorage = memoryStorage();
  var partialLocal = localFixture();
  var partialOriginal = clone(partialLocal);
  var failed = await executor.executeMigration(options(partialClient, partialStorage, partialLocal));
  assert.equal(failed.success, false);
  assert.equal(failed.stage, "books");
  assert.equal(failed.written.books, 1);
  assert.equal(journalFrom(partialStorage).status, "in_progress");
  assert.deepEqual(partialLocal, partialOriginal);
  var firstBookId = partialClient.inspect().writes[0].clientId;
  partialClient.clearFailure();
  var resumed = await executor.executeMigration(options(partialClient, partialStorage, partialLocal));
  assert.equal(resumed.success, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.written.books, 1);
  assert.equal(partialClient.inspect().writes.filter(function(write){ return write.table === "books" && write.clientId === firstBookId; }).length, 1);
  assert.equal(journalFrom(partialStorage).status, "complete");

  /* F. Manifest mismatch prevents resume and writes. */
  var partialData = await normalizedCloud(localFixture());
  var hashStorage = memoryStorage();
  var badJournal = dryRun.createMigrationJournal(partialData.manifest, "in_progress", { startedAt:fixedNow, updatedAt:fixedNow });
  badJournal.manifestHash = "sha256:" + "0".repeat(64);
  hashStorage.setItem(dryRun.migrationJournalKey(userId), JSON.stringify(badJournal));
  var hashClient = mockClient({ books:[partialData.cloud.books[0]], readingLogs:[], bookNotes:[] });
  var hashResult = await executor.executeMigration(options(hashClient, hashStorage, localFixture()));
  assert.equal(hashResult.success, false);
  assert.equal(hashResult.blocked, true);
  assert.equal(hashClient.inspect().writes.length, 0);

  /* H. Verification failure never marks the journal complete. */
  var corruptClient = mockClient(null, { corruptVerification:{ afterWrites:6 } });
  var corruptStorage = memoryStorage();
  var corrupt = await executor.executeMigration(options(corruptClient, corruptStorage, localFixture()));
  assert.equal(corrupt.success, false);
  assert.equal(corrupt.stage, "verification");
  assert.equal(journalFrom(corruptStorage).status, "in_progress");

  /* Journal contains no token/auth material. */
  var serializedJournal = JSON.stringify(journalFrom(storage));
  assert.equal(/access_token|refresh_token|service_role|anonKey/i.test(serializedJournal), false);

  console.log("PASS safe migration executor tests");
})().catch(function(error){
  console.error("FAIL safe migration executor tests", error);
  process.exitCode = 1;
});
