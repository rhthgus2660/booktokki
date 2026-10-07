"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
var assets=require("../../home-room-assets.js");

assert.deepEqual(Object.keys(assets.CHARACTER_ASSETS),["B01","B02","B03","B04","B05","B06","B07","B08"]);
assert.deepEqual(Object.keys(assets.FURNITURE_ASSETS),["F01","F02","F03","F04","F05","F06","F07","F08"]);

Object.keys(assets.CHARACTER_ASSETS).forEach(function(id){
  var item=assets.CHARACTER_ASSETS[id];
  assert.equal(item.id,id);assert.equal(fs.existsSync(path.join(__dirname,"../..",item.asset)),true,"character asset exists: "+id);
});
Object.keys(assets.FURNITURE_ASSETS).forEach(function(id){
  var item=assets.FURNITURE_ASSETS[id];
  assert.equal(item.id,id);assert.equal(fs.existsSync(path.join(__dirname,"../..",item.asset)),true,"furniture asset exists: "+id);
  assert.equal(typeof item.anchor.x,"number");assert.equal(typeof item.anchor.y,"number");
  assert.equal(typeof item.interactionType,"string");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname,"../..",item.asset))).digest("hex"),item.sha256,"approved asset hash: "+id);
});

assert.deepEqual(assets.starterFurniture(),[],"Starter entitlement grants no purchasable furniture");
assert.equal(assets.BACKGROUND.id,"R01_CLEAN_ROOM");
assert.equal(assets.BACKGROUND.type,"room_background");
assert.equal(assets.BACKGROUND.starter,true);assert.equal(assets.BACKGROUND.movable,false);
assert.equal(assets.CORE.movable,false);assert.equal(assets.CORE.removable,false);assert.equal(assets.CORE.width,73.791705069124);
assert.deepEqual(assets.CORE.interactionSpot,{x:29,y:44});
assert.deepEqual([assets.FURNITURE_ASSETS.F02.width,assets.FURNITURE_ASSETS.F03.width,assets.FURNITURE_ASSETS.F04.width],[24.75,45.5,24]);
assert.equal(assets.FURNITURE_ASSETS.F02.semanticSpotType,"REST_SPOT");
assert.equal(assets.FURNITURE_ASSETS.F03.semanticSpotType,"TABLE");
assert.equal(assets.FURNITURE_ASSETS.F08.semanticSpotType,"REST_SPOT");
assert.equal(assets.FURNITURE_ASSETS.F08.interactionType,"rest","rocking-chair exposes the approved B08 rest contact");
assert.equal(assets.FURNITURE_ASSETS.F05.width,40,"Founder-approved Rug width is the Production default");
assert.deepEqual([assets.FURNITURE_ASSETS.F07.x,assets.FURNITURE_ASSETS.F07.y,assets.FURNITURE_ASSETS.F07.width,assets.FURNITURE_ASSETS.F07.layer],[null,null,null,null],"F07 has no invented Starter placement");
assert.equal(assets.FURNITURE_ASSETS.F07.enabled,false);
[assets.BACKGROUND,assets.CORE,assets.CHARACTER_ASSETS.B01,assets.CHARACTER_ASSETS.B08].forEach(function(item){
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname,"../..",item.asset))).digest("hex"),item.sha256);
});

console.log("PASS canonical character/furniture manifests and Starter Room overlap policy tests");
