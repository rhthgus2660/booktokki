"use strict";

var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");
var dryRun = require("../migration-dry-run.js");
var bootstrap = require("../cloud-bootstrap.js");

var userId = "11111111-1111-4111-8111-111111111111";
var now = "2026-09-24T00:00:00.000Z";

function localFixture(blobCover){
  return { books:[{
    id:"book-1", title:"책", author:"저자", totalPages:100, currentPage:30, status:"reading",
    notes:[{ id:"note-1", bookId:"book-1", text:"흔적", page:30, createdAt:"2026-09-22T02:00:00.000Z" }],
    pageLogs:[{ id:"log-1", date:"2026-09-22", prevPage:0, currentPage:30, delta:30, at:"2026-09-22T01:00:00.000Z" }],
    createdAt:"2026-09-20T00:00:00.000Z", updatedAt:"2026-09-22T02:00:00.000Z",
    completedAt:null, lastPageLogDate:"2026-09-22", dayStartPage:0,
    coverId:blobCover ? "image-1" : null,
    coverUrl:blobCover ? "blob:http://localhost/cover" : "https://example.com/cover.jpg"
  }], images:blobCover ? [{ id:"image-1", blob:new Blob(["cover"]) }] : [] };
}
function emptyLocal(){ return { books:[], images:[] }; }
function emptyCloud(){ return { books:[], readingLogs:[], bookNotes:[] }; }
function clone(value){ return structuredClone(value); }
function cloudForUser(snapshot, nextUserId){
  var copy = clone(snapshot);
  copy.books.forEach(function(row){ row.user_id = nextUserId; });
  copy.readingLogs.forEach(function(row){ row.user_id = nextUserId; });
  copy.bookNotes.forEach(function(row){ row.user_id = nextUserId; });
  return copy;
}

async function cloudFromLocal(local){
  var normalized = adapter.normalizeLocalSnapshot(local, userId);
  var refs = { "book-1":{ cloudId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision:1, userId:userId } };
  var rows = adapter.materializeCloudRows(normalized, refs);
  return {
    normalized:normalized,
    manifest:await adapter.createMigrationManifest(normalized),
    snapshot:{
      books:rows.books.map(function(row){ return Object.assign({ id:refs[row.client_id].cloudId, revision:1 }, row); }),
      readingLogs:rows.readingLogs.map(function(row){ return Object.assign({ id:"cloud-" + row.client_id, created_at:now }, row); }),
      bookNotes:rows.bookNotes.map(function(row){ return Object.assign({ id:"cloud-" + row.client_id }, row); })
    }
  };
}
function services(state, counters){
  return {
    readLocal:async function(){ return clone(state.local); },
    readCloud:async function(){ return clone(state.cloud); },
    readJournal:async function(){ return state.journal ? clone(state.journal) : null; },
    readOwner:async function(){ return state.owner ? clone(state.owner) : null; },
    writeOwner:async function(){
      counters.ownerWrites = (counters.ownerWrites || 0) + 1;
      state.owner = { version:1, userId:userId };
      return clone(state.owner);
    },
    migrate:async function(){
      counters.migrate += 1;
      state.cloud = clone(state.targetCloud);
      state.journal = clone(state.completeJournal);
      return { success:true, written:{ books:1, readingLogs:1, bookNotes:1 }, localPreserved:true };
    },
    restore:async function(){
      counters.restore += 1;
      state.local = clone(state.targetLocal);
      return { success:true, localWrites:1, cloudUnchanged:true };
    }
  };
}
function completeJournal(manifest){
  return dryRun.createMigrationJournal(manifest, "complete", { startedAt:now, updatedAt:now, completedAt:now });
}

(async function(){
  var local = localFixture(false);
  var cloud = await cloudFromLocal(local);

  /* 1. EMPTY */
  var ownerA = { version:1, userId:userId };
  var userB = "22222222-2222-4222-8222-222222222222";
  var ownerB = { version:1, userId:userB };
  var inspected = await bootstrap.inspectBootstrapState({ localSnapshot:emptyLocal(), cloudSnapshot:emptyCloud(), userId:userId, journal:null, owner:null });
  assert.equal(inspected.state, bootstrap.STATES.EMPTY);
  assert.equal(inspected.canStart, true);

  /* 2. LOCAL_ONLY */
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:emptyCloud(), userId:userId, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.LOCAL_ONLY);

  /* 3. CLOUD_ONLY */
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:emptyLocal(), cloudSnapshot:cloud.snapshot, userId:userId, journal:null, owner:null });
  assert.equal(inspected.state, bootstrap.STATES.CLOUD_ONLY);

  /* 4. SYNCED, including a Local-only Blob cover excluded from Cloud. */
  var blobLocal = localFixture(true);
  var blobCloud = await cloudFromLocal(blobLocal);
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:blobLocal, cloudSnapshot:blobCloud.snapshot, userId:userId, journal:completeJournal(blobCloud.manifest) });
  assert.equal(inspected.state, bootstrap.STATES.SYNCED);
  assert.equal(inspected.canStart, true);

  /* 5. CONFLICT */
  var conflictCloud = clone(cloud.snapshot);
  conflictCloud.books[0].title = "다른 제목";
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:conflictCloud, userId:userId, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.CONFLICT);

  /* Equivalent timestamp offsets compare as the same instant. */
  var equivalentTimestampCloud = clone(cloud.snapshot);
  equivalentTimestampCloud.books[0].created_at = "2026-09-20T00:00:00.000+00:00";
  equivalentTimestampCloud.books[0].updated_at = "2026-09-22T02:00:00.000+00:00";
  equivalentTimestampCloud.readingLogs[0].recorded_at = "2026-09-22T01:00:00.000+00:00";
  equivalentTimestampCloud.bookNotes[0].created_at = "2026-09-22T02:00:00.000+00:00";
  equivalentTimestampCloud.bookNotes[0].updated_at = "2026-09-22T02:00:00.000+00:00";
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:equivalentTimestampCloud, userId:userId, journal:null });
  assert.equal(inspected.state, bootstrap.STATES.SYNCED);

  /* A genuinely different timestamp remains a conflict. */
  var differentTimestampCloud = clone(equivalentTimestampCloud);
  differentTimestampCloud.books[0].updated_at = "2026-09-22T02:01:00.000+00:00";
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:differentTimestampCloud, userId:userId, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.CONFLICT);

  /* Matching null timestamps retain their existing equality behavior. */
  var matchingNullCloud = clone(equivalentTimestampCloud);
  assert.equal(local.books[0].completedAt, null);
  assert.equal(matchingNullCloud.books[0].completed_at, null);
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:matchingNullCloud, userId:userId, journal:null });
  assert.equal(inspected.state, bootstrap.STATES.SYNCED);

  /* Null on only one side remains a conflict. */
  var mismatchedNullCloud = clone(equivalentTimestampCloud);
  mismatchedNullCloud.books[0].completed_at = "2026-09-23T12:34:56.789+00:00";
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:mismatchedNullCloud, userId:userId, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.CONFLICT);

  /* 6/11. INVALID_CLOUD_STATE, including another user. */
  var invalidCloud = clone(cloud.snapshot);
  invalidCloud.readingLogs[0].book_id = "missing-parent";
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:emptyLocal(), cloudSnapshot:invalidCloud, userId:userId, journal:null });
  assert.equal(inspected.state, bootstrap.STATES.INVALID_CLOUD_STATE);
  var wrongUser = clone(cloud.snapshot);
  wrongUser.books[0].user_id = "22222222-2222-4222-8222-222222222222";
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:emptyLocal(), cloudSnapshot:wrongUser, userId:userId, journal:null });
  assert.equal(inspected.state, bootstrap.STATES.INVALID_CLOUD_STATE);

  /* 7. RESUMABLE_MIGRATION */
  var partial = { books:[clone(cloud.snapshot.books[0])], readingLogs:[], bookNotes:[] };
  var progress = dryRun.createMigrationJournal(cloud.manifest, "in_progress", { startedAt:now, updatedAt:now });
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:partial, userId:userId, journal:progress });
  assert.equal(inspected.state, bootstrap.STATES.RESUMABLE_MIGRATION);

  /* Local owner guard: same owner may continue, another owner always fails closed. */
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:cloud.snapshot, userId:userId, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.SYNCED);
  counters = { migrate:0, restore:0 };
  state = { local:clone(local), cloud:clone(cloud.snapshot), journal:null, owner:clone(ownerA) };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.SYNCED);
  assert.equal(result.canStart, true);
  assert.deepEqual(result.writes, { local:0, cloud:0 });
  assert.deepEqual(counters, { migrate:0, restore:0 });
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:emptyCloud(), userId:userB, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.LOCAL_OWNER_MISMATCH);
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:cloud.snapshot, userId:userB, journal:null, owner:ownerA });
  assert.equal(inspected.state, bootstrap.STATES.INVALID_CLOUD_STATE);

  /* Ownerless legacy Local data needs verified current-user evidence. */
  inspected = await bootstrap.inspectBootstrapState({
    localSnapshot:local, cloudSnapshot:cloud.snapshot, userId:userId,
    journal:completeJournal(cloud.manifest), owner:null
  });
  assert.equal(inspected.state, bootstrap.STATES.SYNCED);
  assert.equal(inspected.shouldClaimOwner, true);
  inspected = await bootstrap.inspectBootstrapState({ localSnapshot:local, cloudSnapshot:emptyCloud(), userId:userId, journal:null, owner:null });
  assert.equal(inspected.state, bootstrap.STATES.LOCAL_OWNER_MISMATCH);

  /* A validated in-progress journal is the only state that invokes resume. */
  counters = { migrate:0, restore:0 };
  state = {
    local:clone(local), cloud:clone(partial), journal:clone(progress),
    targetCloud:clone(cloud.snapshot), completeJournal:completeJournal(cloud.manifest)
  };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.SYNCED);
  assert.equal(result.action, "resume_migration");
  assert.equal(counters.migrate, 1);

  /* Production orchestration: LOCAL_ONLY migrates and reaches SYNCED. */
  var counters = { migrate:0, restore:0 };
  var state = {
    local:clone(local), cloud:emptyCloud(), journal:null, owner:clone(ownerA),
    targetCloud:clone(cloud.snapshot), completeJournal:completeJournal(cloud.manifest)
  };
  var result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.SYNCED);
  assert.equal(result.canStart, true);
  assert.equal(result.action, "migration");
  assert.equal(counters.migrate, 1);

  /* 12. Second bootstrap is a no-op. */
  var second = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(second.state, bootstrap.STATES.SYNCED);
  assert.equal(second.action, "none");
  assert.equal(counters.migrate, 1);

  /* CLOUD_ONLY restore is visible to the next Local read without reload. */
  counters = { migrate:0, restore:0 };
  state = { local:emptyLocal(), cloud:clone(cloud.snapshot), journal:null, targetLocal:clone(local) };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.SYNCED);
  assert.equal(result.action, "restore");
  assert.equal(result.canStart, true);
  assert.equal(state.local.books.length, 1);
  assert.equal(counters.restore, 1);
  assert.deepEqual(state.owner, ownerA);
  assert.equal(counters.ownerWrites, 1);

  /* An owner from an empty previous Local library does not block B's Cloud restore. */
  counters = { migrate:0, restore:0 };
  state = { local:emptyLocal(), cloud:clone(cloudForUser(cloud.snapshot, userB)), journal:null, owner:clone(ownerA), targetLocal:clone(local) };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userB, services:{
    readLocal:async function(){ return clone(state.local); },
    readCloud:async function(){ return clone(state.cloud); },
    readJournal:async function(){ return null; },
    readOwner:async function(){ return state.owner ? clone(state.owner) : null; },
    writeOwner:async function(){ counters.ownerWrites = (counters.ownerWrites || 0) + 1; state.owner = clone(ownerB); },
    restore:async function(){ counters.restore += 1; state.local = clone(state.targetLocal); return { success:true, localWrites:1, cloudUnchanged:true }; }
  }});
  assert.equal(result.state, bootstrap.STATES.SYNCED);
  assert.equal(result.action, "restore");
  assert.deepEqual(state.owner, ownerB);

  /* Empty Local and Cloud starts safely and binds future Local data to this user. */
  counters = { migrate:0, restore:0 };
  state = { local:emptyLocal(), cloud:emptyCloud(), journal:null };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userB, services:{
    readLocal:async function(){ return clone(state.local); },
    readCloud:async function(){ return clone(state.cloud); },
    readJournal:async function(){ return null; },
    readOwner:async function(){ return null; },
    writeOwner:async function(){ counters.ownerWrites = (counters.ownerWrites || 0) + 1; state.owner = clone(ownerB); }
  }});
  assert.equal(result.state, bootstrap.STATES.EMPTY);
  assert.equal(result.canStart, true);
  assert.deepEqual(state.owner, ownerB);

  /* Logout/account switch simulation: A's Local books never migrate to B. */
  counters = { migrate:0, restore:0 };
  state = { local:clone(local), cloud:emptyCloud(), journal:null, owner:clone(ownerA) };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userB, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.LOCAL_OWNER_MISMATCH);
  assert.equal(result.canStart, false);
  assert.deepEqual(counters, { migrate:0, restore:0 });

  /* A's Local plus B's existing Cloud also blocks every automatic action. */
  var cloudForB = clone(cloud.snapshot);
  cloudForB.books[0].user_id = userB;
  cloudForB.readingLogs[0].user_id = userB;
  cloudForB.bookNotes[0].user_id = userB;
  counters = { migrate:0, restore:0 };
  state = { local:clone(local), cloud:cloudForB, journal:null, owner:clone(ownerA) };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userB, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.LOCAL_OWNER_MISMATCH);
  assert.equal(result.canStart, false);
  assert.deepEqual(counters, { migrate:0, restore:0 });

  /* Verified ownerless legacy SYNCED data claims the current owner once. */
  counters = { migrate:0, restore:0 };
  state = { local:clone(local), cloud:clone(cloud.snapshot), journal:completeJournal(cloud.manifest), owner:null };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.SYNCED);
  assert.equal(result.canStart, true);
  assert.deepEqual(state.owner, ownerA);
  assert.equal(counters.ownerWrites, 1);

  /* Conflict performs no action. */
  counters = { migrate:0, restore:0 };
  state = { local:clone(local), cloud:conflictCloud, journal:null, owner:clone(ownerA) };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.CONFLICT);
  assert.equal(result.canStart, false);
  assert.deepEqual(counters, { migrate:0, restore:0 });

  /* Invalid Cloud state also performs no action. */
  counters = { migrate:0, restore:0 };
  state = { local:emptyLocal(), cloud:invalidCloud, journal:null };
  result = await bootstrap.runSafeCloudBootstrap({ userId:userId, services:services(state, counters) });
  assert.equal(result.state, bootstrap.STATES.INVALID_CLOUD_STATE);
  assert.equal(result.canStart, false);
  assert.deepEqual(counters, { migrate:0, restore:0 });

  /* Restore failure is fail-closed and never starts the app. */
  result = await bootstrap.runSafeCloudBootstrap({
    userId:userId,
    services:{
      readLocal:async function(){ return emptyLocal(); },
      readCloud:async function(){ return clone(cloud.snapshot); },
      readJournal:async function(){ return null; },
      readOwner:async function(){ return null; },
      writeOwner:async function(){ throw new Error("owner must not be written"); },
      restore:async function(){ return { success:false, localWrites:0, error:{ message:"transaction aborted" } }; }
    }
  });
  assert.equal(result.state, bootstrap.STATES.ERROR);
  assert.equal(result.canStart, false);

  /* A failed ownerless resumable migration never claims an owner. */
  var ownerClaimedAfterFailedResume = false;
  result = await bootstrap.runSafeCloudBootstrap({
    userId:userId,
    services:{
      readLocal:async function(){ return clone(local); },
      readCloud:async function(){ return clone(partial); },
      readJournal:async function(){ return clone(progress); },
      readOwner:async function(){ return null; },
      writeOwner:async function(){ ownerClaimedAfterFailedResume = true; },
      migrate:async function(){ return { success:false, written:{ books:0, readingLogs:0, bookNotes:0 }, error:{ message:"network" } }; }
    }
  });
  assert.equal(result.state, bootstrap.STATES.ERROR);
  assert.equal(result.canStart, false);
  assert.equal(ownerClaimedAfterFailedResume, false);
  assert.equal(result.writes.local, 0);

  /* 8. Migration failure does not start the app and leaves resume state to the executor. */
  result = await bootstrap.runSafeCloudBootstrap({
    userId:userId,
    services:{
      readLocal:async function(){ return clone(local); },
      readCloud:async function(){ return emptyCloud(); },
      readJournal:async function(){ return null; },
      readOwner:async function(){ return clone(ownerA); },
      writeOwner:async function(){ throw new Error("owner must not be written"); },
      migrate:async function(){ return { success:false, written:{ books:1, readingLogs:0, bookNotes:0 }, error:{ message:"network" } }; }
    }
  });
  assert.equal(result.state, bootstrap.STATES.ERROR);
  assert.equal(result.canStart, false);

  /* 10. Network failure produces ERROR and no destructive fallback. */
  result = await bootstrap.runSafeCloudBootstrap({
    userId:userId,
    services:{
      readLocal:async function(){ return clone(local); },
      readCloud:async function(){ throw new Error("offline"); },
      readJournal:async function(){ return null; }
    }
  });
  assert.equal(result.state, bootstrap.STATES.ERROR);
  assert.equal(result.canStart, false);
  assert.deepEqual(result.writes, { local:0, cloud:0 });

  console.log("PASS safe cloud bootstrap tests");
})().catch(function(error){
  console.error("FAIL safe cloud bootstrap tests", error);
  process.exitCode = 1;
});
