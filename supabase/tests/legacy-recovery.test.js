"use strict";
var assert = require("node:assert/strict");
var adapter = require("../migration-adapter.js");
var restore = require("../cloud-restore.js");
var bootstrap = require("../cloud-bootstrap.js");
var recovery = require("../legacy-recovery.js");

var USER="11111111-1111-4111-8111-111111111111";
function book(id,page){ return {id:id,title:"fixture "+id,author:"author",totalPages:300,currentPage:page,status:page?"reading":"toread",notes:page?[{id:"note-"+id,bookId:id,text:"fixture",page:page,createdAt:"2026-09-27T02:00:00.000Z"}]:[],pageLogs:page?[{id:"log-"+id,date:"2026-09-27",prevPage:0,currentPage:page,delta:page,at:"2026-09-27T01:00:00.000Z"}]:[],createdAt:"2026-09-26T00:00:00.000Z",updatedAt:"2026-09-27T02:00:00.000Z",completedAt:null,lastPageLogDate:page?"2026-09-27":null,dayStartPage:page?0:null,coverId:null,coverUrl:null}; }
function local(){ return {books:[book("local-a",20),book("local-b",0)],images:[]}; }
function cloudFrom(localBooks){
  var n=adapter.normalizeLocalSnapshot({books:localBooks,images:[]},USER), refs={};
  n.books.forEach(function(b,i){refs[b.client_id]={cloudId:"cloud-"+i,revision:1,userId:USER};});
  var rows=adapter.materializeCloudRows(n,refs);
  return {books:rows.books.map(function(r){return Object.assign({id:refs[r.client_id].cloudId,revision:1},r);}),readingLogs:rows.readingLogs.map(function(r){var x=Object.assign({id:"id-"+r.client_id},r);delete x._book_client_id;return x;}),bookNotes:rows.bookNotes.map(function(r){var x=Object.assign({id:"id-"+r.client_id},r);delete x._book_client_id;return x;})};
}
function store(){var data={};return {getItem:function(k){return data[k]||null;},setItem:function(k,v){data[k]=v;}};}
async function bootstrapDiagnostics(cloudSnapshot,localBooks){ var d=await require("../../owner-diagnostics.js").compareSnapshots({localSnapshot:{books:localBooks,images:[]},cloudSnapshot:cloudSnapshot,userId:USER,ownerState:"MISSING"}); return d.cloudBooks===d.matchedBooks && d.cloudReadingLogs===d.matchedReadingLogs && d.cloudBookNotes===d.matchedBookNotes; }
(async function(){
  var localSnap=local(), cloud=cloudFrom([book("cloud-base",0)]);
  var candidate=await recovery.prepareCandidate({ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:cloud});
  assert.equal(candidate.state,recovery.STATES.CANDIDATE); assert.equal(candidate.eligible,true);
  var overlap=await recovery.prepareCandidate({ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:cloudFrom([book("local-a",20)])});
  assert.equal(overlap.state,recovery.STATES.CONFLICT);
  var match=await recovery.prepareCandidate({ownerState:"MATCH",userId:USER,localSnapshot:localSnap,cloudSnapshot:cloud});
  assert.equal(match.eligible,false);
  var resume=await recovery.prepareCandidate({ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:cloudFrom([book("cloud-base",0),book("local-a",20)]),allowResume:true});
  assert.equal(resume.eligible,true);
  assert.equal(recovery.canWriteOwner({finalEquality:false,recoveryJournalStatus:"complete",standardJournalStatus:"complete",ownerState:"MISSING"}),false);
  var deferred=recovery.finalizeOwner({finalEquality:true,recoveryJournalStatus:"complete",standardJournalStatus:"complete",ownerState:"MISSING",userId:USER,verifyFinal:function(){return {finalEquality:true,recoveryJournalStatus:"complete",standardJournalStatus:"complete"};},writeOwner:function(){throw new Error("must be deferred");}});
  assert.equal(deferred.written,true); assert.equal(typeof deferred.write,"function");
  var finalState=true, finalWrite=false, guarded=recovery.finalizeOwner({userId:USER,ownerState:"MISSING",verifyFinal:function(){return finalState?{finalEquality:true,recoveryJournalStatus:"complete",standardJournalStatus:"complete"}:{finalEquality:false,recoveryJournalStatus:"in_progress",standardJournalStatus:"complete"};},writeOwner:function(){finalWrite=true;}});
  finalState=false; assert.throws(function(){guarded.write();}); assert.equal(finalWrite,false);
  var changedBook=book("local-a",20); changedBook.title="different";
  var contentConflict=await recovery.prepareCandidate({ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:cloudFrom([changedBook]),allowResume:true});
  assert.equal(contentConflict.state,recovery.STATES.CONFLICT);
  var wrongParent=cloudFrom(localSnap.books); wrongParent.readingLogs[0].book_id=wrongParent.books[1].id;
  var parentConflict=await recovery.prepareCandidate({ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:wrongParent,allowResume:true});
  assert.equal(parentConflict.state,recovery.STATES.CONFLICT);
  var backup=await recovery.createBackupPayload(localSnap,cloud,USER); var receipt=await recovery.verifyBackupPayload(backup,USER); assert.equal(backup.version,1); assert.equal(backup.local.books.length,2); assert.equal(backup.cloud.books.length,1);
  var j=recovery.writeJournal(store(),{version:1,userId:USER,status:"in_progress"}); assert.equal(j.status,"in_progress");
  function fakeClient(state,failTable){
    var failed=false, keyFor=function(table){return table==="books"?"books":(table==="reading_logs"?"readingLogs":"bookNotes");};
    return { from:function(table){
      return {
        insert:function(row){ return { select:function(){ return { single:async function(){
          if (failTable===table && !failed){ failed=true; return {error:{code:"TEST_FAILURE",message:"fixture failure"}}; }
          var copy=structuredClone(row); copy.id=table+"-"+(state[keyFor(table)].length+1); if(table==="books") copy.revision=1; state[keyFor(table)].push(copy); return {data:copy,error:null};
        }}; }}; },
        select:function(){ var filters=[]; var query={eq:function(column,value){ filters.push([column,value]); return query; },maybeSingle:async function(){ var rows=state[keyFor(table)].filter(function(row){return filters.every(function(pair){return row[pair[0]]===pair[1];});}); return {data:rows[0]||null,error:null}; }}; return query; }
      };
    }};
  }
  var baseline=cloudFrom([book("cloud-base",0)]), recoveryCloud=structuredClone(baseline), journalStore=store(), calls=[];
  var readCloud=function(){ calls.push("select"); return Promise.resolve(structuredClone(recoveryCloud)); };
  var failing=await recovery.execute({backupPayload:backup,backupReceipt:receipt,standardJournalStatus:"NONE",ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:baseline,baselineSnapshot:baseline,storage:journalStore,client:fakeClient(recoveryCloud,"reading_logs"),readCloud:readCloud,now:function(){return "2026-09-27T03:00:00.000Z";}});
  assert.equal(failing.success,false); assert.equal(recoveryCloud.books.some(function(r){return r.client_id==="local-a";}),true); assert.equal(recoveryCloud.bookNotes.length,0);
  var resumed=await recovery.execute({backupPayload:backup,backupReceipt:receipt,standardJournalStatus:"NONE",ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:recoveryCloud,baselineSnapshot:baseline,storage:journalStore,client:fakeClient(recoveryCloud,null),readCloud:readCloud,now:function(){return "2026-09-27T03:05:00.000Z";}});
  assert.equal(resumed.success,true); assert.equal(recoveryCloud.books.length,3); assert.equal(recoveryCloud.readingLogs.length,1); assert.equal(recoveryCloud.bookNotes.length,1);
  var noteCloud=structuredClone(baseline), noteStore=store(), noteBackup=await recovery.createBackupPayload(localSnap,baseline,USER), noteFail=await recovery.execute({backupPayload:noteBackup,backupReceipt:await recovery.verifyBackupPayload(noteBackup,USER),standardJournalStatus:"NONE",ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:baseline,baselineSnapshot:baseline,storage:noteStore,client:fakeClient(noteCloud,"book_notes"),readCloud:function(){return Promise.resolve(structuredClone(noteCloud));},now:function(){return "2026-09-27T04:00:00.000Z";}});
  assert.equal(noteFail.success,false); assert.equal(noteCloud.readingLogs.length,1);
  var noteResume=await recovery.execute({backupPayload:noteBackup,backupReceipt:await recovery.verifyBackupPayload(noteBackup,USER),standardJournalStatus:"NONE",ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:noteCloud,baselineSnapshot:baseline,storage:noteStore,client:fakeClient(noteCloud,null),readCloud:function(){return Promise.resolve(structuredClone(noteCloud));},now:function(){return "2026-09-27T04:05:00.000Z";}});
  assert.equal(noteResume.success,true); assert.equal(noteCloud.bookNotes.length,1);

  function fakeDatabase(initial,failAdd){
    var state={books:structuredClone(initial),images:[{id:"img-1",blob:{marker:"blob"}}]}, before;
    return {state:state,transaction:function(){ before=structuredClone(state.books); var tx={}; tx.abort=function(){state.books=before; if(tx.onabort) setTimeout(tx.onabort,0);}; tx.objectStore=function(){return {getAll:function(){var req={result:structuredClone(state.books)};setTimeout(function(){if(req.onsuccess)req.onsuccess();},0);return req;},add:function(row){if(failAdd) throw new Error("fixture add failure"); if(state.books.some(function(x){return x.id===row.id;})) throw new Error("collision"); state.books.push(structuredClone(row));}};}; setTimeout(function(){if(tx.oncomplete)tx.oncomplete();},20); return tx;}};
  }
  var mergeDb=fakeDatabase(localSnap.books,false), merged=await recovery.mergeCloudOnlyBooks({cloudSnapshot:baseline,userId:USER,localSnapshot:localSnap,database:mergeDb});
  assert.equal(merged.added,1); assert.equal(mergeDb.state.books.length,3); assert.equal(mergeDb.state.images[0].blob.marker,"blob");
  var collisionDb=fakeDatabase(localSnap.books.concat([{id:"cloud-base",title:"collision"}]),false), collisionFailed=false;
  try { await recovery.mergeCloudOnlyBooks({cloudSnapshot:baseline,userId:USER,localSnapshot:localSnap,database:collisionDb}); } catch (_collision) { collisionFailed=true; }
  assert.equal(collisionFailed,true);
  var failDb=fakeDatabase(localSnap.books,true), failRolledBack=false;
  try { await recovery.mergeCloudOnlyBooks({cloudSnapshot:baseline,userId:USER,localSnapshot:localSnap,database:failDb}); } catch (_mergeFail) { failRolledBack=true; }
  assert.equal(failRolledBack,true); assert.equal(failDb.state.books.length,2);

  var mutatedBaseline=structuredClone(baseline); mutatedBaseline.books[0].title="changed on cloud";
  var baselineGuard=await recovery.execute({backupPayload:backup,backupReceipt:receipt,standardJournalStatus:"NONE",ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:baseline,storage:store(),client:fakeClient(mutatedBaseline,null),readCloud:function(){return Promise.resolve(structuredClone(mutatedBaseline));}});
  assert.equal(baselineGuard.success,false); assert.equal(baselineGuard.error.message,"Immutable Cloud baseline changed");
  var blocked=await recovery.execute({standardJournalStatus:"NONE",backupConfirmed:true,ownerState:"MISSING",userId:USER,localSnapshot:localSnap,cloudSnapshot:baseline,storage:store(),client:fakeClient(structuredClone(baseline),null),readCloud:readCloud});
  assert.equal(blocked.success,false); assert.equal(blocked.reason,"Verified backup receipt is required");
  assert.equal(recovery.validateJournal({version:1,userId:USER,status:"in_progress",localManifestHash:"x",baselineCloudHash:"y",phase:"bogus",baselineCounts:{}},USER),false);
  var tampered=structuredClone(backup); tampered.local.books[0].title="tampered"; assert.equal(await recovery.verifyBackupPayload(tampered,USER),null);
  var local7={books:Array.from({length:7},function(_,i){return book("legacy-"+(i+1),i===0?20:0);}),images:[]}, cloud2=cloudFrom([book("cloud-1",0),book("cloud-2",0)]), cloud9=structuredClone(cloud2), iBackup=await recovery.createBackupPayload(local7,cloud2,USER), iStore=store();
  var iReceipt=await recovery.verifyBackupPayload(iBackup,USER); var iExec=await recovery.execute({backupPayload:iBackup,backupReceipt:iReceipt,standardJournalStatus:"NONE",ownerState:"MISSING",userId:USER,localSnapshot:local7,cloudSnapshot:cloud2,baselineSnapshot:cloud2,storage:iStore,client:fakeClient(cloud9,null),readCloud:function(){return Promise.resolve(structuredClone(cloud9));},now:function(){return "2026-09-27T05:00:00.000Z";}});
  assert.equal(iExec.success,true); assert.equal(cloud9.books.length,9);
  var iDb=fakeDatabase(local7.books,false); var iMerge=await recovery.mergeCloudOnlyBooks({cloudSnapshot:cloud9,userId:USER,localSnapshot:local7,database:iDb});
  assert.equal(iMerge.added,2); assert.equal(iDb.state.books.length,9); assert.equal(iDb.state.books.filter(function(b){return b.id.indexOf("legacy-")===0;}).length,7);
  var iCheck=await bootstrapDiagnostics(cloud9,iDb.state.books);
  assert.equal(iCheck,true);
  console.log("legacy-recovery tests: PASS");
})().catch(function(error){ console.error(error); process.exitCode=1; });
