"use strict";
var assert=require("node:assert/strict");
var adapter=require("../migration-adapter.js");
var resolver=require("../conflict-resolution.js");

var USER="11111111-1111-4111-8111-111111111111";
function clone(v){return structuredClone(v);}
function book(id,page,title){return {id:id,title:title||id,author:"author",totalPages:100,currentPage:page,status:page?"reading":"toread",
  notes:page?[{id:"note-"+id,bookId:id,text:"note",page:page,createdAt:"2026-09-20T02:00:00.000Z"}]:[],
  pageLogs:page?[{id:"log-"+id,date:"2026-09-20",prevPage:0,currentPage:page,delta:page,at:"2026-09-20T01:00:00.000Z"}]:[],
  createdAt:"2026-09-19T00:00:00.000Z",updatedAt:"2026-09-20T02:00:00.000Z",completedAt:null,
  lastPageLogDate:page?"2026-09-20":null,dayStartPage:page?0:null,coverId:null,coverUrl:null};}
function cloudFrom(local){
  var normalized=adapter.normalizeLocalSnapshot(local,USER), refs={};
  normalized.books.forEach(function(row){refs[row.client_id]={cloudId:"cloud-"+row.client_id,revision:1,userId:USER};});
  var rows=adapter.materializeCloudRows(normalized,refs);
  return {books:rows.books.map(function(row){return Object.assign({id:refs[row.client_id].cloudId,revision:1},row);}),
    readingLogs:rows.readingLogs.map(function(row){return Object.assign({id:"cloud-"+row.client_id,created_at:row.recorded_at},row);}),
    bookNotes:rows.bookNotes.map(function(row){return Object.assign({id:"cloud-"+row.client_id},row);})};
}
function memoryDb(books,images,behavior){
  behavior=behavior||{};var committed={books:clone(books||[]),images:clone(images||[])},writes=0,puts=0;
  function request(work){var req={};queueMicrotask(function(){try{req.result=work();if(req.onsuccess)req.onsuccess();}catch(e){req.error=e;if(req.onerror)req.onerror();}});return req;}
  return {transaction:function(names,mode){var tx={oncomplete:null,onabort:null,onerror:null,error:null},staging=clone(committed),aborted=false;
    if(mode==="readwrite")writes++;
    tx.abort=function(){if(aborted)return;aborted=true;tx.error=tx.error||new Error("abort");queueMicrotask(function(){if(tx.onabort)tx.onabort();});};
    tx.objectStore=function(name){return {getAll:function(){return request(function(){return clone(staging[name]);});},clear:function(){if(mode!=="readwrite")throw new Error("readonly");staging[name]=[];return request(function(){});},put:function(value){
      if(mode!=="readwrite")throw new Error("readonly");puts++;if(behavior.failPutAt===puts){tx.error=new Error("put failed");queueMicrotask(tx.abort);return request(function(){throw tx.error;});}
      var at=staging[name].findIndex(function(row){return row.id===value.id;});if(at<0)staging[name].push(clone(value));else staging[name][at]=clone(value);return request(function(){return value.id;});}};};
    setTimeout(function(){if(aborted)return;if(mode==="readwrite")committed=staging;if(tx.oncomplete)tx.oncomplete();},0);return tx;},
    inspect:function(){return {books:clone(committed.books),images:clone(committed.images),writes:writes};}};
}
function client(cloud,calls){var rows={books:cloud.books,reading_logs:cloud.readingLogs,book_notes:cloud.bookNotes};return {from:function(table){calls.push("select:"+table);return {select:function(){return {eq:function(){return {order:function(){return Promise.resolve({data:clone(rows[table]),error:null});}};}};},insert:function(){calls.push("write");throw new Error("cloud write");},update:function(){calls.push("write");throw new Error("cloud write");},delete:function(){calls.push("write");throw new Error("cloud write");},upsert:function(){calls.push("write");throw new Error("cloud write");}};},rpc:function(){calls.push("write");throw new Error("cloud write");}};}
function storage(){var values={"booktokki:local-owner:v1":JSON.stringify({version:1,userId:USER})};return {getItem:function(k){return values[k]??null;},setItem:function(k,v){values[k]=v;}};}

(async function(){
  var local={books:[book("local-only",5)],images:[{id:"image-1",blob:new Blob(["cover"],{type:"image/png"})}]};
  var cloudLocal={books:[book("cloud-book",30,"cloud canonical")],images:[]}, cloud=cloudFrom(cloudLocal), calls=[];
  var db=memoryDb(local.books,local.images), store=storage();
  var prepared=await resolver.prepare({database:db,client:client(cloud,calls),storage:store,userId:USER});
  assert.equal(prepared.state,"READY");assert.equal(db.inspect().writes,0,"prepare and CTA display perform no Local writes");
  await assert.rejects(resolver.resolve({context:prepared,database:db,client:client(cloud,calls),storage:store,userId:USER}),/Downloaded verified backup/);
  var downloads=0;resolver.downloadPreparedBackup(prepared,null,function(payload){downloads++;assert.equal(payload.local.books[0].id,"local-only");});
  assert.equal(downloads,1);var result=await resolver.resolve({context:prepared,database:db,client:client(cloud,calls),storage:store,userId:USER});
  assert.equal(result.success,true);assert.equal(result.bootstrap.state,"SYNCED");assert.equal(db.inspect().books.length,1);
  assert.equal(db.inspect().books[0].id,"cloud-book");assert.equal(db.inspect().books[0].pageLogs.length,1);assert.equal(db.inspect().books[0].notes.length,1);
  assert.equal(db.inspect().images.length,1,"conflict replacement preserves images store");assert.equal(calls.includes("write"),false);
  await assert.rejects(resolver.resolve({context:prepared,database:db,client:client(cloud,calls),storage:store,userId:USER}),/locked/);

  var restoreDb=memoryDb([book("changed",0)],[]);
  var restored=await resolver.restoreBackup(restoreDb,prepared.backupPayload,USER);
  assert.equal(restored.success,true);assert.equal(restoreDb.inspect().books[0].id,"local-only");
  assert.equal(restoreDb.inspect().images.length,1);assert.equal(await restoreDb.inspect().images[0].blob.text(),"cover");
  var tamperedBackup=clone(prepared.backupPayload);tamperedBackup.local.images[0].data="dGFtcGVyZWQ=";
  await assert.rejects(resolver.restoreBackup(memoryDb([],[]),tamperedBackup,USER),/Backup verification failed/);

  var failureDb=memoryDb(local.books,local.images,{failPutAt:1}), failurePrepared=await resolver.prepare({database:failureDb,client:client(cloud,[]),storage:storage(),userId:USER});
  resolver.downloadPreparedBackup(failurePrepared,null,function(){});
  await assert.rejects(resolver.resolve({context:failurePrepared,database:failureDb,client:client(cloud,[]),storage:storage(),userId:USER}));
  assert.equal(failureDb.inspect().books[0].id,"local-only","failed transaction rolls back Local books");

  var changedCloud=clone(cloud);changedCloud.books[0].title="changed after backup";
  var baselineDb=memoryDb(local.books,local.images), baselinePrepared=await resolver.prepare({database:baselineDb,client:client(cloud,[]),storage:storage(),userId:USER});
  resolver.downloadPreparedBackup(baselinePrepared,null,function(){});
  await assert.rejects(resolver.resolve({context:baselinePrepared,database:baselineDb,client:client(changedCloud,[]),storage:storage(),userId:USER}),/baseline changed/);
  assert.equal(baselineDb.inspect().writes,0);

  await assert.rejects(resolver.prepare({database:memoryDb(local.books,[]),client:client({books:[],readingLogs:[],bookNotes:[]},[]),storage:storage(),userId:USER}),/Only a validated CONFLICT/);
  var invalidCloud=clone(cloud);invalidCloud.readingLogs[0].book_id="missing-parent";
  await assert.rejects(resolver.prepare({database:memoryDb(local.books,[]),client:client(invalidCloud,[]),storage:storage(),userId:USER}),/Only a validated CONFLICT/);
  var failingClient={from:function(){return {select:function(){return {eq:function(){return {order:function(){return Promise.resolve({data:null,error:new Error("offline")});}};}};}};}};
  await assert.rejects(resolver.prepare({database:memoryDb(local.books,[]),client:failingClient,storage:storage(),userId:USER}),/offline/);
  var mismatchStore=storage();mismatchStore.setItem("booktokki:local-owner:v1",JSON.stringify({version:1,userId:"22222222-2222-4222-8222-222222222222"}));
  await assert.rejects(resolver.prepare({database:memoryDb(local.books,[]),client:client(cloud,[]),storage:mismatchStore,userId:USER}),/Only a validated CONFLICT/);
  console.log("PASS conflict resolution tests");
})().catch(function(error){console.error("FAIL conflict resolution tests",error);process.exitCode=1;});
