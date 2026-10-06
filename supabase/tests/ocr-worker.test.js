"use strict";
var assert=require("node:assert/strict"),path=require("node:path"),url=require("node:url");
async function run(){
  var worker=(await import(url.pathToFileURL(path.join(__dirname,"../../worker/src/index.js")).href+"?ocr="+Date.now())).default;
  var app="https://rhthgus2660.github.io",calls=[];
  function request(type,body,token){return new Request("https://worker.example/ocr",{method:"POST",headers:{Origin:app,"Content-Type":type,Authorization:"Bearer "+(token||"token")},body:body});}
  var env={SUPABASE_URL:"https://project.supabase.co",SUPABASE_ANON_KEY:"anon",OCR_PROVIDER:"google-vision",GOOGLE_VISION_API_KEY:"secret",OCR_RATE_LIMITER:{limit:function(){return Promise.resolve({success:true});}}};
  global.fetch=function(target,options){calls.push({target:String(target),options:options});if(String(target).includes("/auth/v1/user"))return Promise.resolve(new Response(JSON.stringify({id:"u1"}),{status:200}));return Promise.resolve(new Response(JSON.stringify({responses:[{fullTextAnnotation:{text:"한글 문장\nEnglish line"}}]}),{status:200}));};
  var ok=await worker.fetch(request("image/jpeg",new Uint8Array([1,2])),env);assert.equal(ok.status,200);assert.deepEqual((await ok.json()).lines,["한글 문장","English line"]);assert.equal(calls.length,2);
  var noAuth=await worker.fetch(new Request("https://worker.example/ocr",{method:"POST",headers:{Origin:app,"Content-Type":"image/jpeg"},body:new Uint8Array([1])}),env);assert.equal(noAuth.status,401);
  var disabled=await worker.fetch(request("image/jpeg",new Uint8Array([1])),Object.assign({},env,{GOOGLE_VISION_API_KEY:""}));assert.equal(disabled.status,503,"provider stays disabled without secret");
  assert.equal((await worker.fetch(request("text/plain",new Uint8Array([1])),env)).status,415);
  assert.equal((await worker.fetch(request("image/jpeg",new Uint8Array(4*1024*1024+1)),env)).status,413);
  assert.equal((await worker.fetch(request("image/jpeg",new Uint8Array([1])),Object.assign({},env,{OCR_RATE_LIMITER:{limit:function(){return Promise.resolve({success:false});}}}))).status,429);
  global.fetch=function(target,options){if(String(target).includes("/auth/v1/user"))return Promise.resolve(new Response(JSON.stringify({id:"u1"}),{status:200}));return new Promise(function(_resolve,reject){options.signal.addEventListener("abort",function(){var error=new Error("aborted");error.name="AbortError";reject(error);});});};
  assert.equal((await worker.fetch(request("image/jpeg",new Uint8Array([1])),Object.assign({},env,{OCR_TIMEOUT_MS:1}))).status,504,"provider timeout is bounded");
  global.fetch=function(target,options){calls.push({target:String(target),options:options});if(String(target).includes("/auth/v1/user"))return Promise.resolve(new Response(JSON.stringify({id:"u1"}),{status:200}));return Promise.resolve(new Response(JSON.stringify({responses:[{fullTextAnnotation:{text:"safe"}}]}),{status:200}));};
  var logged=false,oldLog=console.log;console.log=function(){logged=true;};await worker.fetch(request("image/jpeg",new Uint8Array([9,8,7])),env);console.log=oldLog;assert.equal(logged,false,"OCR bodies/results are not logged");
  console.log("PASS OCR worker tests");
}
run().catch(function(error){console.error(error);process.exit(1);});
