"use strict";
var assert = require("node:assert/strict");
var repository = require("../../cloud-repository.js");
var user = "11111111-1111-4111-8111-111111111111";
var other = "22222222-2222-4222-8222-222222222222";
var tick = 0;
function clone(v){ return structuredClone(v); }
function mockClient(){
  var db={books:[],reading_logs:[],book_notes:[]}, failRpc=false;
  function Q(table,op,payload){ this.table=table;this.op=op||"select";this.payload=payload;this.filters=[]; }
  Q.prototype.select=function(){return this;}; Q.prototype.eq=function(k,v){this.filters.push([k,v]);return this;};
  Q.prototype.order=function(){return this;}; Q.prototype.single=function(){this.singleMode=true;return this;};
  Q.prototype.maybeSingle=function(){this.maybe=true;return this;};
  Q.prototype.insert=function(v){this.op="insert";this.payload=v;return this;};
  Q.prototype.update=function(v){this.op="update";this.payload=v;return this;};
  Q.prototype.delete=function(){this.op="delete";return this;};
  Q.prototype.then=function(resolve){
    var rows=db[this.table], matches=function(r){return this.filters.every(function(f){return r[f[0]]===f[1];});}.bind(this), data,error=null;
    if(this.op==="select") data=rows.filter(matches).map(clone);
    if(this.op==="insert"){
      var p=clone(this.payload), dup=rows.find(function(r){return r.user_id===p.user_id&&r.client_id===p.client_id;});
      if(dup) error={code:"23505",status:409}; else { p.id=p.id||"uuid-"+(rows.length+1);p.revision=p.revision||1;rows.push(p);data=clone(p); }
    }
    if(this.op==="update"){
      var found=rows.find(matches); if(!found) error={code:"PGRST116",status:406}; else {Object.assign(found,clone(this.payload));if(this.table==="books"){found.revision++;found.updated_at="2026-09-24T00:00:0"+(++tick)+".000Z";}data=clone(found);}
    }
    if(this.op==="delete") {var foundIndex=rows.findIndex(matches);if(foundIndex<0)data=[];else{data=[clone(rows[foundIndex])];rows.splice(foundIndex,1);}}
    if(Array.isArray(data)&&(this.singleMode||this.maybe)) data=data[0]||null;
    return Promise.resolve({data:data,error:error}).then(resolve);
  };
  var client={
    from:function(t){return new Q(t);},
    rpc:function(name,p){
      if(failRpc)return Promise.resolve({data:null,error:{message:"offline"}});
      var b=db.books.find(function(x){return x.id===p.p_book_id&&x.user_id===user;});
      if(!b)return Promise.resolve({data:null,error:{code:"P0002"}});
      var existing=db.reading_logs.find(function(x){return x.user_id===user&&x.client_id===p.p_log_client_id;});
      if(existing)return Promise.resolve({data:[{book_id:b.id,revision:b.revision,log_created:true}],error:null});
      if(b.revision!==p.p_expected_revision)return Promise.resolve({data:null,error:{code:"PT409",status:409}});
      var page=Math.max(0,Math.min(b.total_pages,p.p_new_page)), made=page!==b.current_page;
      if(made)db.reading_logs.push({id:"log-"+(db.reading_logs.length+1),user_id:user,book_id:b.id,client_id:p.p_log_client_id,log_date:p.p_log_date,previous_page:b.current_page,current_page:page,delta:page-b.current_page,recorded_at:p.p_recorded_at});
      b.day_start_page=b.last_page_log_date!==p.p_log_date?b.current_page:(b.day_start_page==null?b.current_page:b.day_start_page);b.last_page_log_date=p.p_log_date;b.current_page=page;b.status=page===b.total_pages?"done":page>0?"reading":"toread";b.completed_at=b.status==="done"?(b.completed_at||p.p_recorded_at):null;b.revision++;b.updated_at="2026-09-24T00:00:0"+(++tick)+".000Z";
      return Promise.resolve({data:[{book_id:b.id,revision:b.revision,log_created:made}],error:null});
    },
    state:db,setRpcFailure:function(v){failRpc=v;}
  };return client;
}
function localBook(id){return{id:id,title:"책",author:"저자",totalPages:100,currentPage:0,status:"toread",notes:[],pageLogs:[],createdAt:"2026-09-20T00:00:00.000Z",updatedAt:"2026-09-20T00:00:00.000Z",completedAt:null,lastPageLogDate:null,dayStartPage:null,coverId:"blob-1",coverUrl:"blob:http://local/1"};}
(async function(){
 var client=mockClient(),repo=repository.create(client),book=localBook("book-1");
 var row=await repo.createBook(user,book);assert.equal(row.client_id,"book-1");assert.equal(row.cover_source_url,null);
 var duplicate=await repo.createBook(user,book);assert.equal(duplicate.id,row.id);assert.equal(client.state.books.length,1);
 await repo.loadSnapshot(user);
 var forward=await repo.recordPage(user,"book-1",{logId:"l1",newPage:20,date:"2026-09-24",at:"2026-09-24T01:00:00.000Z"});assert.equal(forward.log.delta,20);
 var retry=await repo.recordPage(user,"book-1",{logId:"l1",newPage:20,date:"2026-09-24",at:"2026-09-24T01:00:00.000Z"});assert.equal(client.state.reading_logs.length,1);assert.equal(retry.logCreated,true);
 var back=await repo.recordPage(user,"book-1",{logId:"l2",newPage:5,date:"2026-09-24",at:"2026-09-24T02:00:00.000Z"});assert.equal(back.log.delta,-15);
 var same=await repo.recordPage(user,"book-1",{logId:"same",newPage:5,date:"2026-09-24",at:"2026-09-24T03:00:00.000Z"});assert.equal(same.logCreated,false);assert.equal(client.state.reading_logs.length,2);
 client.state.books[0].revision++;await assert.rejects(repo.recordPage(user,"book-1",{logId:"stale",newPage:9,date:"2026-09-24",at:"2026-09-24T04:00:00.000Z"}),function(e){return e.name==="CloudConflictError"&&!!e.latestBook;});
 await repo.loadSnapshot(user);client.setRpcFailure(true);await assert.rejects(repo.recordPage(user,"book-1",{logId:"network",newPage:9,date:"2026-09-24",at:"2026-09-24T04:00:00.000Z"}),/CLOUD_WRITE_FAILED/);client.setRpcFailure(false);
 var note={id:"n1",bookId:"book-1",text:"흔적",page:5,createdAt:"2026-09-24T05:00:00.000Z"};await repo.createNote(user,"book-1",note);await repo.createNote(user,"book-1",note);assert.equal(client.state.book_notes.length,1);
 await repo.updateNote(user,"book-1","n1","수정");assert.equal(client.state.book_notes[0].text,"수정");await repo.deleteNote(user,"book-1","n1");assert.equal(client.state.book_notes.length,0);
 await assert.rejects(repo.createBook(other,Object.assign({},book,{id:"book-1"})),/user mismatch/);
 var completed=await repo.updateBook(user,"book-1",{status:"done",completed_at:"2026-09-24T06:00:00.000Z",completion_reflection_text:"소감",completion_reflection_created_at:"2026-09-24T06:00:00.000Z",completion_reflection_updated_at:"2026-09-24T06:00:00.000Z"});assert.equal(completed.status,"done");assert.equal(completed.completion_reflection_text,"소감");
 await repo.deleteBook(user,"book-1");await repo.deleteBook(user,"book-1");assert.equal(client.state.books.length,0);
 console.log("PASS core cloud repository sync tests");
})().catch(function(e){console.error("FAIL core cloud repository sync tests",e);process.exitCode=1;});
