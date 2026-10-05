"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
const api=require("../../continue-reading.js"), analytics=require("../../analytics-repository.js");
function observerHarness(){
 const state={view:"home"},doc={visibilityState:"visible",querySelector:()=>row};
 const row={isConnected:true,getAttribute:()=>"book"};let observer,events=[],ids=0;
 const flow=api.createFlow();
 const src=html.slice(html.indexOf("function observeContinueReading("),html.indexOf('document.addEventListener("visibilitychange", observeContinueReading)'));
 const observe=new Function("state","document","continueReadingReady","appStarted","continueReadingFlow","trackContinueReading","uid","IntersectionObserver","continueReadingObserver",src+";return observeContinueReading;")(state,doc,true,true,flow,(...e)=>events.push(e),()=>"view-"+(++ids),function(callback){observer={disconnect(){},observe(){},fire:callback};return observer;},null);
 return {state,doc,row,observe,fire:ratio=>observer.fire([{target:row,isIntersecting:true,intersectionRatio:ratio}]),events};
}
let o=observerHarness();o.observe();o.fire(.4);assert.equal(o.events.length,0);o.fire(.5);o.fire(1);assert.equal(o.events.length,1);
o=observerHarness();o.state.view="detail";o.observe();assert.equal(o.events.length,0);
o=observerHarness();o.observe();o.row.isConnected=false;o.fire(1);assert.equal(o.events.length,0);
o=observerHarness();o.observe();o.doc.visibilityState="hidden";o.fire(1);assert.equal(o.events.length,0);
function pageHarness(delta,fail){
 const flow=api.createFlow();flow.viewed("book","exposure");flow.clicked("book");flow.entered("book");
 const state={books:{book:{id:"book",currentPage:10,totalPages:100,pageLogs:[]}}};
 const src=html.slice(html.indexOf("function logPage("),html.indexOf("// Read existing page history"));
 const logPage=new Function("state","queueCloudMutation","getBooks","buildPageLogPatch","readingReaction","todayStr","uid","cloudRepository","activeAuthUserId","localBookFromCloudRow","commitLocalBook","document","showReadingReaction","queueFirstRecordFeedbackPrompt","cloudSaveFailed","continueReadingFlow",src+";return logPage;")(state,(_,f)=>f(),()=>[state.books.book],(book,page)=>({currentPage:page,updatedAt:"2026-10-05T01:00:00Z",pageLogs:delta ? [{id:"log"}] : null}),()=>null,()=>"2026-10-05",()=>"log",{recordPage:()=>fail?Promise.reject(new Error("offline")):Promise.resolve({logCreated:delta!==0,log:delta!==0?{delta}:null,logs:[],book:{}})},"user",x=>x,x=>Promise.resolve(x),{querySelector:()=>null},()=>{},()=>{},()=>{},flow);
 return {logPage};
}
(async()=>{
 for(const delta of [-5,0,20]){
  let metadata;const h=pageHarness(delta,false);
  assert.equal(await h.logPage("book",10+delta,{onSaved:m=>metadata=m}),true);
  assert.equal(metadata.pageDelta,delta);assert.equal(metadata.continueReadingId,"exposure");
  // Optional-note failure/close retains successful first page attribution.
  let sent;
  const session=analytics.createReadingRecordSession({eventId:"save",bookId:"cloud-book",send:event=>sent=Object.assign(event,metadata)});
  session.handleResult({pageSaved:true,partial:true},"2026-10-05T01:01:00Z");session.close();session.close();
  assert.equal(sent.pageDelta,delta);assert.equal(sent.continueReadingId,"exposure");assert.equal(sent.withNote,false);
 }
 let called=false;
 assert.equal(await pageHarness(20,true).logPage("book",30,{onSaved:()=>called=true}),false);assert.equal(called,false);
 console.log("PASS Continue Reading actual visibility observer, Cloud save metadata, failure and partial-note attribution");
})().catch(error=>{console.error(error);process.exitCode=1;});
