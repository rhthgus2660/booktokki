"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var recall=require("../../p7-recall.js");
var now=new Date(2026,9,15,12,0,0);
function note(id,days,text){return {id:id,text:text||"기록",createdAt:new Date(now.getTime()-days*86400000).toISOString()};}
function book(id,notes){return {id:id,title:"책 "+id,notes:notes||[],pageLogs:[{id:"page-only",delta:3,at:new Date(now.getTime()-40*86400000).toISOString()}]};}
function storage(initial,options){var data=Object.assign({},initial||{}),opts=options||{};return {data:data,getItem:function(key){if(opts.readFail)throw new Error("read");return Object.prototype.hasOwnProperty.call(data,key)?data[key]:null;},setItem:function(key,value){if(opts.writeFail)throw new Error("write");data[key]=value;}};}

var empty={version:1,notes:{}};
assert.equal(recall.selectRecall([book("recent",[note("n13",13)])],null,empty,now),null,"notes younger than 14 days are excluded");
assert.equal(recall.selectRecall([book("eligible",[note("n14",14)])],null,empty,now).noteId,"n14","the 14-day boundary is eligible");
assert.equal(recall.selectRecall([book("continue",[note("n",40)])],"continue",empty,now),null,"Continue Reading book is excluded");
assert.equal(recall.selectRecall([book("page-only",[])],null,empty,now),null,"page history alone never becomes a P7-B recall");
assert.equal(recall.selectRecall([],null,empty,now),null,"deleted books and notes cannot be recalled");
assert.equal(recall.selectRecall([book("blank",[note("blank",40,"　")])],null,empty,now),null,"blank notes are excluded");
assert.equal(recall.selectRecall([book("future",[{id:"future",text:"기록",createdAt:new Date(now.getTime()+1000).toISOString()}])],null,empty,now),null,"future timestamps are excluded");
var untitled=book("untitled",[note("old",40)]);untitled.title="　";
assert.equal(recall.selectRecall([untitled],null,empty,now),null,"factual recall requires a real book title");

var cooldown={version:1,notes:{same:new Date(now.getTime()-29*86400000).toISOString()}};
assert.equal(recall.selectRecall([book("b",[note("same",40)])],null,cooldown,now),null,"same note is suppressed before 30 days");
cooldown.notes.same=new Date(now.getTime()-30*86400000).toISOString();
assert.equal(recall.selectRecall([book("b",[note("same",40)])],null,cooldown,now).noteId,"same","same note is eligible at 30 days");

var monday=new Date(2026,9,12,9,0,0),sunday=new Date(2026,9,18,23,0,0);
var weekly={version:1,notes:{a:monday.toISOString(),b:sunday.toISOString()}};
assert.equal(recall.weeklyDisplayCount(weekly,now),2,"Monday through Sunday is one local week");
assert.equal(recall.selectRecall([book("b",[note("third",40)])],null,weekly,now),null,"weekly exposure stops at two");
assert.equal(recall.weeklyDisplayCount(weekly,new Date(2026,9,19,0,1,0)),0,"a new local Monday resets the count");

var user="user-a",store=storage();
assert.equal(recall.readHistory(store,user).ok,true,"missing history starts empty");
assert.equal(recall.recordDisplayed(store,user,"note-a",now),true);
var saved=JSON.parse(store.data[recall.storageKey(user)]);
assert.deepEqual(Object.keys(saved).sort(),["notes","version"]);
assert.deepEqual(Object.keys(saved.notes),["note-a"],"only note ID and display time are persisted");
assert.equal(saved.notes["note-a"],now.toISOString());
assert.equal(recall.readHistory(storage({[recall.storageKey(user)]:"{"}),user).ok,false,"corrupt history fails closed");
assert.equal(recall.readHistory(storage({}, {readFail:true}),user).ok,false,"read failure fails closed");
assert.equal(recall.recordDisplayed(storage({}, {writeFail:true}),user,"note",now),false,"write failure fails closed");
assert.notEqual(recall.storageKey("user-a"),recall.storageKey("user-b"),"accounts have separate keys");

var html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");
assert.match(html,/src="\.\/p7-recall\.js"/);
assert.match(html,/p6Repository\.claim\(\)[\s\S]*fallbackHomeCharacterMoment/,"P6 remains ahead of P7-B fallback");
assert.doesNotMatch(html.slice(html.indexOf("function fallbackHomeCharacterMoment"),html.indexOf("function acknowledgeP6Reaction")),/selectLibrarianMoment/,"legacy page-based P4 recall no longer runs on Home");
assert.match(html,/openReadingRecap\(ctaBook,"home",ctaNote\)/);
assert.match(html,/state\.view!=="home"/,"screen exit prevents a pending Home recall from being displayed");
assert.match(html,/activeAuthUserId!==p4Session\.userId/,"account switches invalidate the prior user's recall");
assert.match(html,/state\.books\[ctaBook\][\s\S]*\.some\(function\(note\)/,"CTA revalidates the note before navigation so deletion is safe");
assert.match(html,/recapAnchorEventId/);
assert.match(html,/resetP4Session\(null\);resetP6Session\(null\)/,"account switch resets the shared speech session");
console.log("PASS P7-B past Book Log recall, cooldown, navigation and lifecycle contracts");
