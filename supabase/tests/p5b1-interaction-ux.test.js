const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const html=fs.readFileSync(path.join(__dirname,"../../index.html"),"utf8");

test("visitor bubble is portaled above the isolated Room actor stack",()=>{
  assert.match(html,/#view-home \.home-scene\{[\s\S]*?isolation:isolate/);
  assert.match(html,/#view-home \.home-scene-shell\{[\s\S]*?position:relative/);
  assert.match(html,/#view-home \.home-scene-overlay-root\{[\s\S]*?z-index:1[\s\S]*?pointer-events:none/);
  assert.match(html,/#view-home \.visitor-message-bubble\{[\s\S]*?background:#fff[\s\S]*?pointer-events:auto/);
  assert.match(html,/<\/section><div class="home-scene-overlay-root"[\s\S]*?homeSceneVisitorBubble\(scene\.visitors\.find/);
  assert.match(html,/shell=scene&&scene\.closest\("\.home-scene-shell"\),bubble=shell&&shell\.querySelector/);
  assert.match(html,/actorRect=actor\.getBoundingClientRect\(\)/);
  assert.doesNotMatch(html,/image=actor\.querySelector\("img"\),visualRect=/);
  assert.match(html,/visitorBubbleTimer=setTimeout\(function\(\)[\s\S]*?closeVisitorBubble\(\)[\s\S]*?\},5000\);/);
  assert.match(html,/data-visitor-message/);
});

test("visitor bubble may overlap the actor but stays inside 375px and 390px Rooms",()=>{
  const source=html.slice(html.indexOf("  function visitorBubbleCoordinates("),html.indexOf("  function positionVisitorBubble("));
  const context={};vm.createContext(context);vm.runInContext(source+"\nthis.place=visitorBubbleCoordinates;",context);
  for(const width of [375,390]){
    for(const visual of [{left:4,top:6,width:136,height:164},{left:width-140,top:270,width:136,height:175},{left:120,top:170,width:135,height:160}]){
      const bubble={width:144,height:72},point=context.place({left:0,top:0,width,height:455},visual,bubble);
      assert.ok(point.left>=10&&point.left+bubble.width<=width-10);
      assert.ok(point.top>=10&&point.top+bubble.height<=445);
    }
  }
});

test("offline DM contracts never use Home presence as an authorization source",()=>{
  const migration=["20261008232749_p5b_conversation.sql","202610100001_p5b1_messaging.sql"].map(name=>fs.readFileSync(path.join(__dirname,"../migrations",name),"utf8")).join("\n");
  for(const name of ["list_friend_conversations","get_friend_messages","send_friend_message"]){
    const start=migration.indexOf("function public."+name);
    assert.notEqual(start,-1);
    const body=migration.slice(start,migration.indexOf("end $$;",start)+7);
    assert.doesNotMatch(body,/app_presence|touch_friend_presence|friend_visit/i);
  }
  assert.match(html,/coReadingRepository\.getConnections\(\)\.then\(function\(connections\)/);
  assert.doesNotMatch(html,/function openConversation\(connectionId\)[\s\S]{0,500}friendVisit|function openConversationActions\(\)[\s\S]{0,900}state\.friendVisit/);
});

test("received-message reporting uses long press with scroll cancellation and keyboard access",()=>{
  assert.doesNotMatch(html,/class="conversation-message-report"/);
  assert.match(html,/data-message-report-target tabindex="0" role="button" aria-haspopup="menu"/);
  assert.match(html,/messageLongPressTimer=setTimeout\([\s\S]*?600\)/);
  assert.match(html,/Math\.abs\(e\.clientX-messageLongPressStart\.x\)>8\|\|Math\.abs\(e\.clientY-messageLongPressStart\.y\)>8/);
  assert.match(html,/document\.addEventListener\("contextmenu"[\s\S]*?e\.preventDefault\(\)/);
  assert.match(html,/e\.key==="Enter"\|\|e\.key===" "\|\|\(e\.shiftKey&&e\.key==="F10"\)/);
  assert.match(html,/data-message-menu-report/);
  assert.match(html,/openConversationMessageReport\(reportMessageId\)/);
});

test("conversation menu reuses profile and block flows while preserving read-only history",()=>{
  assert.match(html,/data-conversation-more/);
  assert.match(html,/data-conversation-profile/);
  assert.match(html,/data-conversation-block/);
  assert.match(html,/coReadingRepository\.getConnections\(\)\.then\(function\(connections\)/);
  assert.match(html,/userId!==activeAuthUserId\|\|connectionId!==state\.selectedConversationId\|\|state\.view!=="conversation"/);
  assert.match(html,/coReadingRepository\.blockConnection\(conversationBlockId\)/);
  assert.match(html,/state\.conversationCanSend=false/);
  assert.match(html,/connectionId===conversationBlockId\?Object\.assign\(\{\},item,\{canSend:false\}\):item/);
  assert.match(html,/renderConversationUpdate\(\)/);
});

test("message surfaces use the neutral app palette",()=>{
  assert.match(html,/\.message-banner\{[\s\S]*?border:1px solid var\(--border\)[\s\S]*?background:var\(--surface\)/);
  assert.match(html,/\.conversation-message-menu\{[\s\S]*?border:1px solid #e3e3e3[\s\S]*?background:#fff/);
  assert.doesNotMatch(html,/\.conversation-message-menu\{[^}]*#f8f1e6/);
});
