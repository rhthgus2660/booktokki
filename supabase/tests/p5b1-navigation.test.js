"use strict";

var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
var html=fs.readFileSync(path.join(__dirname,"../..","index.html"),"utf8");
var source=html.slice(html.indexOf("  var socialHistoryReady="),html.indexOf("  function openMyBooklogs("));

function harness(initialView,staleView){
  var listeners={},entries=[{booktokkiNav:true,route:{view:staleView||initialView}}],index=0;
  var history={
    get state(){return entries[index]||null;},
    replaceState:function(value){entries[index]=structuredClone(value);},
    pushState:function(value){entries=entries.slice(0,index+1);entries.push(structuredClone(value));index+=1;},
    back:function(){if(index<1)return;index-=1;(listeners.popstate||[]).forEach(function(fn){fn({state:entries[index]});});}
  };
  var state={view:initialView,inboxReturnView:"home",conversationReturnView:"conversations",friendProfileReturnView:"co-reading",selectedConversationId:"ab",selectedFriendConnectionId:null,conversationMessages:[{id:"m1"}],inboxUnread:0};
  var context={
    state:state,appStarted:true,window:{history:history,location:{href:"https://qa.example/index.html"},addEventListener:function(name,fn){(listeners[name]||(listeners[name]=[])).push(fn);}},
    document:{getElementById:function(){return null;}},continueReadingFlow:{leave:function(){}},friendVisit:null,
    closeVisitorBubble:function(){},closeConversationMessageMenu:function(){},stopConversationPolling:function(){},hideReadingReaction:function(){},enterHomeCharacterMoment:function(){},renderAll:function(){},
    loadCoReading:function(){},loadSocialProfile:function(){},loadBlockedUsers:function(){},loadConversations:function(){},startConversationPolling:function(){}
  };
  vm.createContext(context);vm.runInContext(source,context);
  return{context:context,state:state,history:history,entries:function(){return entries;}};
}

function expectAppBackPath(origin){
  var h=harness(origin,"co-reading");
  h.context.goTo("conversations");
  h.context.goTo("conversation");
  assert.deepEqual(h.entries().map(function(entry){return entry.route.view;}),[origin,"conversations","conversation"]);
  h.context.appBack("conversations");
  assert.equal(h.state.view,"conversations");
  h.context.appBack(origin);
  assert.equal(h.state.view,origin);
}

test("Home and MY Inbox/DM app Back preserve the current visible origin",function(){
  expectAppBackPath("home");
  expectAppBackPath("my");
});

test("visitor DM and friend-profile DM app Back return to their direct origin",function(){
  for(const origin of ["home","friend-profile"]){
    var h=harness(origin,"co-reading");
    h.context.goTo("conversation");
    assert.deepEqual(h.entries().map(function(entry){return entry.route.view;}),[origin,"conversation"]);
    h.context.appBack(origin);
    assert.equal(h.state.view,origin);
  }
});

test("DM profile Back restores the same conversation before its original origin",function(){
  for(const origin of ["home","conversations"]){
    var h=harness(origin,"co-reading"),messages=h.state.conversationMessages;
    h.context.goTo("conversation");
    h.state.selectedFriendConnectionId="ab";
    h.state.friendProfileReturnView="conversation";
    h.context.goTo("friend-profile");
    assert.deepEqual(h.entries().map(function(entry){return entry.route.view;}),[origin,"conversation","friend-profile"]);
    h.context.appBack("conversation");
    assert.equal(h.state.view,"conversation");
    assert.equal(h.state.selectedConversationId,"ab");
    assert.equal(h.state.conversationMessages,messages);
    h.context.appBack(origin);
    assert.equal(h.state.view,origin);
  }
});

test("friend-list profile Back keeps the existing co-reading path",function(){
  var h=harness("co-reading","home");
  h.state.selectedFriendConnectionId="ab";
  h.state.friendProfileReturnView="co-reading";
  h.context.goTo("friend-profile");
  h.context.appBack("co-reading");
  assert.equal(h.state.view,"co-reading");
});

test("browser Back follows the same Inbox/DM route chain",function(){
  var h=harness("library","co-reading");
  h.context.goTo("conversations");h.context.goTo("conversation");
  h.history.back();assert.equal(h.state.view,"conversations");
  h.history.back();assert.equal(h.state.view,"library");
});

test("stale or missing browser route uses the explicit safe fallback",function(){
  var h=harness("conversation","home");
  h.context.appBack("friend-profile");
  assert.equal(h.state.view,"friend-profile");
});
