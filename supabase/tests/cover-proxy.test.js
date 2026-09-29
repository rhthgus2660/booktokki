"use strict";
var assert = require("node:assert/strict");
var path = require("node:path");
var url = require("node:url");

async function run(){
  var worker = (await import(url.pathToFileURL(path.join(__dirname, "../../worker/src/index.js")).href)).default;
  var calls = [];
  var nextUpstream = null;
  global.fetch = function(target, options){ calls.push({ target:String(target), options:options }); return Promise.resolve(nextUpstream()); };
  function req(query, origin){
    var headers = new Headers();
    if (origin) headers.set("Origin", origin);
    return new Request("https://booktokki-search.example/cover" + query, { headers:headers });
  }
  var app = "https://rhthgus2660.github.io";
  var kakao = "https://search1.kakaocdn.net/thumb/R120x174.q85/?fname=http%3A%2F%2Ft1.daumcdn.net%2Flbook%2Fimage%2F1";

  nextUpstream = function(){ return new Response(new Uint8Array([1,2,3]), { status:200, headers:{ "Content-Type":"image/jpeg" } }); };
  var ok = await worker.fetch(req("?url=" + encodeURIComponent(kakao), app), {});
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), app, "allowed origin gets CORS");
  assert.equal(ok.headers.get("Content-Type"), "image/jpeg");
  assert.equal((await ok.arrayBuffer()).byteLength, 3);
  assert.equal(calls[0].target, kakao);
  assert.equal(calls[0].options.redirect, "manual", "redirects are not followed to other hosts");

  calls.length = 0;
  var http = await worker.fetch(req("?url=" + encodeURIComponent("http://t1.daumcdn.net/lbook/image/1"), app), {});
  assert.equal(http.status, 200);
  assert.equal(calls[0].target, "https://t1.daumcdn.net/lbook/image/1", "http cover is upgraded to https");

  calls.length = 0;
  for (var bad of ["https://evil.example/a.jpg", "https://search1.kakaocdn.net.evil.example/a.jpg", "file:///etc/passwd", "https://user:pw@search1.kakaocdn.net/a", "https://search1.kakaocdn.net:8443/a", "not a url", "", "https://search1.kakaocdn.net/thumb/R1/?fname=" + encodeURIComponent("https://evil.example/x.jpg"), "https://search1.kakaocdn.net/other/?fname=" + encodeURIComponent("http://t1.daumcdn.net/lbook/image/1"), "https://t1.daumcdn.net/cafeattach/x.jpg"]){
    var denied = await worker.fetch(req("?url=" + encodeURIComponent(bad), app), {});
    assert.equal(denied.status, 400, "rejects " + bad);
  }
  assert.equal(calls.length, 0, "rejected URLs are never fetched");

  var noOrigin = await worker.fetch(req("?url=" + encodeURIComponent(kakao), null), {});
  assert.equal(noOrigin.status, 403);
  var otherOrigin = await worker.fetch(req("?url=" + encodeURIComponent(kakao), "https://evil.example"), {});
  assert.equal(otherOrigin.status, 403);
  assert.equal(calls.length, 0);

  nextUpstream = function(){ return new Response(new Uint8Array([1]), { status:200, headers:{ "Content-Type":"image/jpg" } }); };
  assert.equal((await worker.fetch(req("?url=" + encodeURIComponent(kakao), app), {})).status, 200, "image/jpg is accepted");
  nextUpstream = function(){ return new Response("<html>", { status:200, headers:{ "Content-Type":"text/html" } }); };
  assert.equal((await worker.fetch(req("?url=" + encodeURIComponent(kakao), app), {})).status, 502, "non-image upstream is refused");
  nextUpstream = function(){ return new Response(null, { status:302, headers:{ Location:"https://evil.example/" } }); };
  assert.equal((await worker.fetch(req("?url=" + encodeURIComponent(kakao), app), {})).status, 502, "redirect is refused");
  nextUpstream = function(){ return new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status:200, headers:{ "Content-Type":"image/png" } }); };
  assert.equal((await worker.fetch(req("?url=" + encodeURIComponent(kakao), app), {})).status, 502, "oversized cover is refused");
  global.fetch = function(){ return Promise.reject(new Error("down")); };
  assert.equal((await worker.fetch(req("?url=" + encodeURIComponent(kakao), app), {})).status, 502);

  var search = await worker.fetch(new Request("https://booktokki-search.example/books?q=", { headers:{ Origin:app } }), {});
  assert.equal(search.status, 400, "existing /books route is unchanged");
  console.log("PASS Cover proxy worker tests");
}
run().catch(function(error){ console.error(error); process.exit(1); });
