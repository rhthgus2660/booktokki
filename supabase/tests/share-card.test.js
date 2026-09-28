"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var shareCard = require(path.join(__dirname, "../../share-card.js"));

function fakeContext(){
  var calls = [];
  return {
    calls:calls,
    fillStyle:"", strokeStyle:"", lineWidth:0, font:"", textAlign:"", textBaseline:"", letterSpacing:"",
    fillRect:function(){ calls.push(["fillRect"].concat([].slice.call(arguments))); },
    strokeRect:function(){ calls.push(["strokeRect"].concat([].slice.call(arguments))); },
    beginPath:function(){ calls.push(["beginPath"]); },
    moveTo:function(){}, lineTo:function(){}, stroke:function(){}, rect:function(){}, clip:function(){}, save:function(){}, restore:function(){},
    drawImage:function(){ calls.push(["drawImage"]); },
    fillText:function(value){ calls.push(["fillText", value]); },
    measureText:function(value){ return { width:Array.from(String(value)).length * 16 }; }
  };
}
function fakeCanvas(context){
  return { width:0, height:0, getContext:function(){ return context; } };
}

var book = {
  id:"private-book-id", title:"죽은 시인의 사회", author:"N. H. 클라인바움", coverUrl:"https://example.com/cover.jpg",
  notes:[{ id:"other-private-note", text:"다른 비공개 북로그" }]
};
var pageNote = { id:"private-note-id", bookId:"private-book-id", text:"교육과 선택에 대한 생각", page:31, createdAt:"2026-09-29T00:00:00.000Z", user_id:"private-user-id" };
var payload = shareCard.buildPayload(book, pageNote);
assert.deepEqual(payload, {
  title:"죽은 시인의 사회", author:"N. H. 클라인바움", page:31,
  note:"교육과 선택에 대한 생각", coverUrl:"https://example.com/cover.jpg"
});
assert.equal(Object.prototype.hasOwnProperty.call(payload, "id"), false);
assert.equal(JSON.stringify(payload).includes("private-user-id"), false);
assert.equal(JSON.stringify(payload).includes("private-note-id"), false);
assert.equal(JSON.stringify(payload).includes("private-book-id"), false);
assert.equal(JSON.stringify(payload).includes("다른 비공개 북로그"), false);

var noPage = shareCard.buildPayload(book, { text:"페이지 없는 북로그", page:null });
assert.equal(noPage.page, null);

var longKorean = "긴 한국어 북로그입니다.".repeat(100);
var wrapContext = fakeContext();
var wrapped = shareCard.wrapText(wrapContext, longKorean, 160, 4);
assert.equal(wrapped.lines.length, 4);
assert.equal(wrapped.truncated, true);
assert.match(wrapped.lines[3], /…$/);

var special = shareCard.buildPayload(book, { text:"<script>alert('x')</script> & 그대로", page:1 });
var specialContext = fakeContext();
shareCard.render(fakeCanvas(specialContext), special, null);
assert.equal(specialContext.calls.some(function(call){ return call[0] === "fillText" && String(call[1]).includes("<script>"); }), true);

var coverContext = fakeContext();
shareCard.render(fakeCanvas(coverContext), payload, { naturalWidth:100, naturalHeight:150 });
assert.equal(coverContext.calls.some(function(call){ return call[0] === "drawImage"; }), true, "safe cover is drawn");

var fallbackContext = fakeContext();
shareCard.render(fakeCanvas(fallbackContext), payload, null);
assert.equal(fallbackContext.calls.some(function(call){ return call[0] === "drawImage"; }), false);
assert.equal(fallbackContext.calls.some(function(call){ return call[0] === "fillText" && call[1] === "죽"; }), true, "cover failure uses graphic fallback");

var tierContext = fakeContext();
var shortLayout = shareCard.layoutNote(tierContext, "짧은 북로그");
assert.equal(shortLayout.tier.size, 34, "short note uses the largest tier");
assert.equal(shortLayout.truncated, false);
var mediumText = "가".repeat(36 * 11);
var mediumLayout = shareCard.layoutNote(fakeContext(), mediumText);
assert.equal(mediumLayout.truncated, false, "medium note fits by shrinking");
assert.ok(mediumLayout.tier.size < 34, "medium note shrinks font");
assert.equal(mediumLayout.lines.join(""), mediumText, "whole note is kept when it fits");
var hugeLayout = shareCard.layoutNote(fakeContext(), "나".repeat(5000));
assert.equal(hugeLayout.tier.size, 22, "huge note uses the smallest tier");
assert.equal(hugeLayout.truncated, true);
var renderedHuge = shareCard.render(fakeCanvas(fakeContext()), shareCard.buildPayload(book, { text:"나".repeat(5000), page:1 }), null);
assert.equal(renderedHuge.truncated, true, "render reports truncation");
assert.equal(shareCard.render(fakeCanvas(fakeContext()), payload, null).truncated, false);
var fontContext = fakeContext();
shareCard.render(fakeCanvas(fontContext), payload, null);
assert.match(fontContext.font, /Gothic A1/, "canvas uses the app font");

var longAuthorContext = fakeContext();
shareCard.render(fakeCanvas(longAuthorContext), shareCard.buildPayload({ title:"반지의 제왕", author:"J. R. R. 톨킨, 김보원, 김번, 이미애, 그리고 아주 긴 공동 역자 이름" }, { text:"메모", page:1 }), null);
var authorCall = longAuthorContext.calls.filter(function(call){ return call[0] === "fillText" && String(call[1]).indexOf("톨킨") >= 0; })[0];
assert.ok(authorCall && Array.from(authorCall[1]).length * 16 <= 394, "long author is fitted to the card");
assert.match(authorCall[1], /…$/);
assert.equal(shareCard.buildPayload(book, { text:"끝에 빈 줄\n\n\n", page:1 }).note, "끝에 빈 줄", "trailing blank lines are not counted as overflow");
var emojiWrap = shareCard.wrapText(fakeContext(), "😀".repeat(50), 160, 1);
assert.equal(emojiWrap.lines[0].indexOf("\uFFFD"), -1);
assert.equal(/[\uD800-\uDBFF]…$/.test(emojiWrap.lines[0]), false, "emoji is never split");

var localCover = shareCard.buildPayload({ title:"로컬 표지", author:"", coverId:"img-1", coverUrl:"blob:https://app/abc" }, { text:"메모", page:2 });
assert.equal(localCover.coverUrl, "blob:https://app/abc", "uploaded local cover is carried as blob URL");

function FileMock(parts, name, options){ this.parts=parts; this.name=name; this.type=options.type; }

async function run(){
  function LoadedImage(){ this.naturalWidth=100; this.naturalHeight=150; }
  Object.defineProperty(LoadedImage.prototype, "src", { set:function(){ var self=this; setTimeout(function(){ self.onload(); }, 0); } });
  var loaded = await shareCard.loadCover("https://example.com/cover.jpg", { Image:LoadedImage });
  assert.equal(loaded instanceof LoadedImage, true);
  assert.equal(loaded.crossOrigin, "anonymous");

  var blobLoaded = await shareCard.loadCover("blob:https://app/abc", { Image:LoadedImage });
  assert.equal(blobLoaded instanceof LoadedImage, true);
  assert.equal(blobLoaded.crossOrigin, undefined, "local blob cover is loaded without CORS mode");

  var fontLoads = [];
  await shareCard.prepareFonts(payload, { document:{ fonts:{ load:function(spec, sample){ fontLoads.push([spec, sample]); return Promise.resolve([]); } } } });
  assert.ok(fontLoads.length >= 2);
  assert.match(fontLoads[0][0], /Gothic A1/);
  assert.ok(fontLoads[0][1].includes("교육과 선택"), "font subset is requested for the note text");
  var started = Date.now();
  await shareCard.prepareFonts(payload, { fontTimeoutMs:20, document:{ fonts:{ load:function(){ return new Promise(function(){}); } } } });
  assert.ok(Date.now() - started < 1000, "font loading never blocks the card");
  await shareCard.prepareFonts(payload, { document:{ fonts:{ load:function(){ return Promise.reject(new Error("font")); } } } });
  await shareCard.prepareFonts(payload, { document:{} });

  var pngCanvas = fakeCanvas(fakeContext());
  pngCanvas.toBlob = function(callback){ callback({ png:true }); };
  var created = await shareCard.createPng(pngCanvas, shareCard.buildPayload(book, { text:"나".repeat(5000), page:3 }), { Image:LoadedImage, document:{} });
  assert.deepEqual(created.blob, { png:true });
  assert.equal(created.truncated, true);
  assert.equal(created.coverDrawn, true);
  var taintedRenders = 0;
  var taintedCanvas = fakeCanvas(fakeContext());
  taintedCanvas.toBlob = function(callback){ taintedRenders += 1; if (taintedRenders === 1) throw new Error("SecurityError"); callback({ png:"no-cover" }); };
  var taintedResult = await shareCard.createPng(taintedCanvas, payload, { Image:LoadedImage, document:{} });
  assert.deepEqual(taintedResult.blob, { png:"no-cover" });
  assert.equal(taintedResult.coverDrawn, false, "tainted cover falls back to no-cover card");

  function FailedImage(){}
  Object.defineProperty(FailedImage.prototype, "src", { set:function(){ var self=this; setTimeout(function(){ self.onerror(); }, 0); } });
  assert.equal(await shareCard.loadCover("https://example.com/broken.jpg", { Image:FailedImage }), null);

  var shared = [];
  var shareResult = await shareCard.sharePng({ png:true }, payload, {
    navigator:{ canShare:function(data){ return data.files[0].type === "image/png"; }, share:function(data){ shared.push(data); return Promise.resolve(); } },
    File:FileMock
  });
  assert.equal(shareResult.method, "share");
  assert.equal(shared.length, 1);

  var clicked = 0, revoked = 0;
  var fallbackResult = await shareCard.sharePng({ png:true }, payload, {
    navigator:{ canShare:function(){ return false; }, share:function(){ throw new Error("must not run"); } },
    File:FileMock,
    document:{ createElement:function(){ return { click:function(){ clicked += 1; } }; } },
    URL:{ createObjectURL:function(){ return "blob:test"; }, revokeObjectURL:function(){ revoked += 1; } }
  });
  assert.equal(fallbackResult.method, "download");
  assert.equal(clicked, 1);

  var cancelResult = await shareCard.sharePng({ png:true }, payload, {
    navigator:{ canShare:function(){ return true; }, share:function(){ var error=new Error("cancel"); error.name="AbortError"; return Promise.reject(error); } },
    File:FileMock
  });
  assert.equal(cancelResult.cancelled, true);

  await new Promise(function(resolve){ setTimeout(resolve, 0); });
  assert.equal(revoked, 1);

  var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
  assert.match(html, /data-sharenote=/);
  assert.match(html, /data-editnote=/);
  assert.match(html, /data-delnote=/);
  assert.match(html, /window\.BooktokkiShareCard\.buildPayload\(book, note\)/);
  assert.match(html, /window\.BooktokkiShareCard\.createPng\(canvas, payload\)/);
  assert.match(html, /result\.truncated \? "글이 길어 일부만 담겼어요/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../../share-card.js"), "utf8"), /analytics|supabase|book_notes/);
  console.log("PASS Public Logs Share Image Card tests");
}

run().catch(function(error){ console.error(error); process.exit(1); });
