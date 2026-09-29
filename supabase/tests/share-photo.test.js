"use strict";
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var shareCard = require(path.join(__dirname, "../../share-card.js"));

function context(){
  var calls = [];
  return {
    calls:calls,
    fillStyle:"", strokeStyle:"", lineWidth:0, font:"", textAlign:"", textBaseline:"", shadowColor:"", shadowBlur:0, letterSpacing:"",
    save:function(){ calls.push(["save"]); }, restore:function(){ calls.push(["restore"]); },
    beginPath:function(){}, rect:function(){}, clip:function(){}, strokeRect:function(){}, moveTo:function(){}, lineTo:function(){}, stroke:function(){},
    translate:function(){ calls.push(["translate"].concat([].slice.call(arguments))); },
    rotate:function(){ calls.push(["rotate"].concat([].slice.call(arguments))); },
    fillRect:function(){ calls.push(["fillRect"].concat([].slice.call(arguments))); },
    drawImage:function(){ calls.push(["drawImage"].concat([].slice.call(arguments))); },
    fillText:function(){ calls.push(["fillText"].concat([].slice.call(arguments))); },
    measureText:function(value){ return { width:Array.from(String(value)).length * 14 }; }
  };
}

function canvas(ctx){
  return { width:0, height:0, getContext:function(){ return ctx; }, toBlob:function(callback){ callback({ png:true }); } };
}

var payload = shareCard.buildPayload(
  { title:"아주 긴 한국어 책 제목이 한 줄을 넘어가는 경우를 확인하는 책", author:"작가" },
  { text:"첫 줄의 생각\n두 번째 생각\n세 번째 생각\n네 번째 생각", page:31, createdAt:"2026-09-29T12:00:00" }
);
var landscape = { width:1600, height:900 };
var portrait = { width:900, height:1600 };

var landscapeCrop = shareCard.centerCrop(landscape, 720, 960);
assert.equal(landscapeCrop.sh, 900);
assert.equal(landscapeCrop.sw, 675);
assert.equal(landscapeCrop.sx, 462.5);
assert.equal(landscapeCrop.sy, 0);
var portraitCrop = shareCard.centerCrop(portrait, 720, 960);
assert.equal(portraitCrop.sw, 900);
assert.equal(portraitCrop.sh, 1200);
assert.equal(portraitCrop.sy, 200);

var photoContext = context();
var photoCanvas = canvas(photoContext);
var rendered = shareCard.renderPhoto(photoCanvas, payload, landscape);
assert.equal(photoCanvas.width, 720);
assert.equal(photoCanvas.height, 960, "Photo output remains 4:5");
assert.equal(rendered.truncated, false);
var background = photoContext.calls.filter(function(call){ return call[0] === "drawImage"; })[0];
assert.deepEqual(background.slice(2), [462.5, 0, 675, 900, 0, 0, 720, 960], "photo is center-cropped full bleed");
assert.equal(photoContext.calls.some(function(call){ return call[0] === "rotate" && call[1] < 0; }), true, "memo has a slight rotation");
assert.equal(photoContext.calls.some(function(call){ return call[0] === "fillText" && call[1] === "9.29 · p.31"; }), true);
assert.equal(photoContext.calls.some(function(call){ return call[0] === "fillText" && call[1] === "BOOKTOKKI"; }), true);
var titleCall = photoContext.calls.filter(function(call){ return call[0] === "fillText" && String(call[1]).indexOf("한국어") >= 0; })[0];
assert.ok(titleCall);
assert.match(titleCall[1], /…$/, "long title is kept to one truncated line");

var noPageContext = context();
shareCard.renderPhoto(canvas(noPageContext), shareCard.buildPayload({ title:"책", author:"저자" }, {
  text:"페이지가 없는 기록", page:null, createdAt:"2026-09-29T12:00:00"
}), portrait);
assert.equal(noPageContext.calls.some(function(call){ return call[0] === "fillText" && call[1] === "9.29"; }), true);
assert.equal(noPageContext.calls.some(function(call){ return call[0] === "fillText" && /p\./.test(String(call[1])); }), false);

var overflow = shareCard.renderPhoto(canvas(context()), shareCard.buildPayload({ title:"책" }, {
  text:"아주 긴 한국어 북로그입니다. ".repeat(100), page:1, createdAt:"2026-09-29T12:00:00"
}), landscape);
assert.equal(overflow.truncated, true, "Photo memo is capped at four lines");

async function run(){
  var created = await shareCard.createPhotoPng(canvas(context()), payload, landscape, { document:{} });
  assert.deepEqual(created.blob, { png:true });
  assert.equal(created.photo, true);
  assert.equal(created.crop.sx, 462.5);
  var selectedPhoto = await shareCard.createShareImage(canvas(context()), payload, landscape, { document:{} });
  assert.equal(selectedPhoto.photo, true, "selecting a photo renders Photo mode");
  var removedPhoto = await shareCard.createShareImage(canvas(context()), payload, null, { document:{} });
  assert.equal(removedPhoto.photo, undefined, "no photo, including after removal, renders the existing Card");

  var bitmapOptions = null;
  var decoded = await shareCard.loadPhotoFile({ name:"iphone.heic", type:"image/heic", size:5000 }, {
    createImageBitmap:function(_file, options){ bitmapOptions=options; return Promise.resolve(portrait); }
  });
  assert.equal(decoded, portrait);
  assert.deepEqual(bitmapOptions, { imageOrientation:"from-image" }, "EXIF orientation is requested during bitmap decode");

  await assert.rejects(function(){
    return shareCard.loadPhotoFile({ name:"huge.jpg", type:"image/jpeg", size:26 * 1024 * 1024 }, {});
  }, /too large/);
  await assert.rejects(function(){
    return shareCard.loadPhotoFile({ name:"note.txt", type:"text/plain", size:10 }, {});
  }, /Unsupported/);

  var revoked = 0;
  function ImageMock(){ this.naturalWidth=1200; this.naturalHeight=1600; }
  Object.defineProperty(ImageMock.prototype, "src", { set:function(){ var self=this; setTimeout(function(){ self.onload(); }, 0); } });
  var imageDecoded = await shareCard.loadPhotoFile({ name:"fallback.heic", type:"image/heic", size:100 }, {
    createImageBitmap:function(){ return Promise.reject(new Error("unsupported")); },
    Image:ImageMock,
    URL:{ createObjectURL:function(){ return "blob:local-photo"; }, revokeObjectURL:function(){ revoked += 1; } }
  });
  assert.equal(imageDecoded instanceof ImageMock, true, "browser image decode is the HEIC fallback");
  assert.equal(revoked, 1);

  var html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
  assert.match(html, /id="sharePhotoInput" type="file" accept="image\/\*,\.heic,\.heif"/);
  assert.match(html, />사진 넣기<\/label>/);
  assert.match(html, />사진 제거<\/button>/);
  assert.match(html, /shareCard\.createShareImage\(canvas, payload, photoImage/);
  assert.match(html, /photoImage = null;[\s\S]*photoAdd\.textContent = "사진 넣기";[\s\S]*renderShareImage\(\)/, "removing a photo rerenders the original Card");
  assert.match(html, /shareCard\.sharePng\(pngBlob, payload\)/, "Photo reuses the existing share path");
  assert.match(html, /window\.open\(previewUrl, "_blank", "noopener"\)/, "iOS image-open path remains unchanged");
  var source = fs.readFileSync(path.join(__dirname, "../../share-card.js"), "utf8");
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|supabase|analytics|upload/, "selected photos never leave the browser");
  console.log("PASS Public Logs Photo V1 tests");
}

run().catch(function(error){ console.error(error); process.exit(1); });
