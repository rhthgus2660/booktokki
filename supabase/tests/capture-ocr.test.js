"use strict";
var assert=require("node:assert/strict");
var Capture=require("../../capture-ocr.js");

async function run(){
  var data={};var storage={getItem:function(k){return data[k]||null;},setItem:function(k,v){data[k]=v;}};
  assert.equal(Capture.hasConsent(storage,"u1"),false);
  Capture.grantConsent(storage,"u1");assert.equal(Capture.hasConsent(storage,"u1"),true);assert.equal(Capture.hasConsent(storage,"u2"),false,"consent is user scoped");
  assert.deepEqual(Capture.normalizeLines([{text:"  한글   문장 "},"English",""]),["한글 문장","English"]);
  assert.equal(Capture.noteText("문장입니다.","내 생각"),"“문장입니다.”\n\n내 생각");
  assert.equal(Capture.noteText("문장만", ""),"“문장만”");
  var book={id:"b1",currentPage:42},calls=[];
  await Capture.save({book:book,quote:"인용",thought:"생각",page:"40",addNote:function(){calls.push([].slice.call(arguments));return true;}});
  assert.equal(calls.length,1,"save calls addNote exactly once");assert.deepEqual(calls[0],["b1","“인용”\n\n생각",40]);assert.equal(book.currentPage,42,"capture never advances current page");
  await assert.rejects(Capture.save({book:book,quote:"",page:40,addNote:function(){calls.push(1);}}),/QUOTE_REQUIRED/);assert.equal(calls.length,1,"invalid capture writes nothing");
  var fetched=0;
  var lines=await Capture.requestOcr({endpoint:"/ocr",token:"t",blob:new Blob(["x"],{type:"image/jpeg"}),fetch:function(_url,options){fetched++;assert.equal(options.method,"POST");assert.equal(options.headers.Authorization,"Bearer t");return Promise.resolve(new Response(JSON.stringify({lines:[" a ","b"]}),{status:200,headers:{"Content-Type":"application/json"}}));}});
  assert.equal(fetched,1);assert.deepEqual(lines,["a","b"]);
  console.log("PASS Capture OCR client tests");
}
run().catch(function(error){console.error(error);process.exit(1);});
