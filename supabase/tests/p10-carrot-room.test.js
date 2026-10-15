"use strict";
var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var root=path.join(__dirname,"../.."),migration=fs.readFileSync(path.join(root,"supabase/migrations/20261014234446_p10_carrot_furniture_room.sql"),"utf8"),html=fs.readFileSync(path.join(root,"index.html"),"utf8"),cloud=fs.readFileSync(path.join(root,"cloud-repository.js"),"utf8"),scene=require(path.join(root,"home-scene.js")),repository=require(path.join(root,"p10-repository.js"));

test("P10 rewards only established Cloud write paths with durable idempotency",function(){
  assert.match(migration,/unique \(user_id,activity_key\)/);
  assert.match(migration,/create table public\.p10_reward_claims/);
  assert.match(migration,/insert into public\.p10_reward_claims[\s\S]*daily-page:[\s\S]*reading_logs/);
  assert.match(migration,/insert into public\.p10_reward_claims[\s\S]*daily-note:[\s\S]*book_notes/);
  assert.match(migration,/first-completion:[\s\S]*reading_logs/);
  assert.match(migration,/new\.delta > 0[\s\S]*reward_write_kind[^=]*='record_page'[\s\S]*'daily_page',1/);
  assert.match(migration,/reward_write_kind[^=]*='book_note'[\s\S]*'daily_note',3/);
  assert.match(migration,/new\.status='done'[\s\S]*old\.status is distinct from 'done'[\s\S]*'first_completion',10/);
  assert.match(migration,/perform set_config\('booktokki\.reward_write_kind','record_page',true\)/);
  assert.match(migration,/perform set_config\('booktokki\.reward_write_kind','book_note',true\)/);
  assert.match(cloud,/client\.rpc\("create_book_note_with_reward"/);
});

test("P10 catalog, ownership and three placements are server controlled",function(){
  assert.match(migration,/\('A','작은 화분',5,0,'F01',1\)/);
  assert.match(migration,/\('B','플로어 램프',10,3,'F04',2\)/);
  assert.match(migration,/\('C','흔들의자',20,7,'F08',3\)/);
  assert.match(migration,/slot_id in \('slot_1','slot_2','slot_3'\)/);
  assert.match(migration,/primary key \(user_id,furniture_id\)/);
  assert.match(migration,/account\.balance<item\.price/);
  assert.match(migration,/days<item\.required_reading_days/);
  assert.match(migration,/pg_advisory_xact_lock/);
});

test("P10 tables deny direct browser access and expose authenticated RPCs only",function(){
  ["p10_carrot_accounts","p10_carrot_ledger","p10_reward_claims","p10_furniture_catalog","p10_furniture_ownership","p10_room_placements"].forEach(function(name){
    assert.match(migration,new RegExp("alter table public\\."+name+" enable row level security"));
    assert.match(migration,new RegExp("revoke all on table public\\."+name+" from public,anon,authenticated,service_role"));
  });
  ["create_book_note_with_reward","get_p10_room_state","purchase_p10_furniture","place_p10_furniture"].forEach(function(name){
    assert.match(migration,new RegExp("revoke all on function public\\."+name+"[\\s\\S]*? from public,anon"));
    assert.match(migration,new RegExp("grant execute on function public\\."+name+"[\\s\\S]*? to authenticated"));
  });
  assert.match(migration,/revoke all on function public\.p10_award_carrots[^;]* from public,anon,authenticated,service_role/);
});

test("P10 repository maps state and preserves RPC boundaries",async function(){
  var calls=[],client={rpc:function(name,args){calls.push([name,args]);return Promise.resolve({data:name==="get_p10_room_state"?[{furniture_id:"A",display_name:"화분",price:5,required_reading_days:0,asset_id:"F01",balance:8,reading_days:1,owned:true,slot_id:"slot_1"}]:true,error:null});}};
  var repo=repository.create(client),rows=await repo.state();
  assert.deepEqual(rows[0],{id:"A",name:"화분",price:5,requiredDays:0,assetId:"F01",balance:8,readingDays:1,owned:true,slotId:"slot_1"});
  await repo.purchase("A","purchase-id"); await repo.place("slot_2",null);
  assert.equal(calls[1][0],"purchase_p10_furniture");
  assert.deepEqual(calls[2],["place_p10_furniture",{p_slot_id:"slot_2",p_furniture_id:null}]);
});

test("Room reuses approved pixel assets in three deterministic slots",function(){
  assert.deepEqual(Object.keys(scene.CUSTOM_FURNITURE_SLOTS),["slot_1","slot_2","slot_3"]);
  var placed=scene.placedFurniture([{slotId:"slot_1",assetId:"F01"},{slotId:"slot_2",assetId:"F04"},{slotId:"slot_3",assetId:"F08"}]);
  assert.equal(placed.length,3); assert.ok(placed.every(function(item){return item.asset&&item.movable;}));
  assert.match(html,/data-p10-open/); assert.match(html,/data-p10-buy/); assert.match(html,/data-p10-place/); assert.match(html,/data-p10-store/);
  assert.match(html,/min-height:44px/); assert.match(html,/placements:p10Placements\(\)/);
});

test("P10 purchase errors are localized without changing server error contracts",function(){
  assert.match(migration,/message='Not enough carrots'/);
  assert.match(html,/message\.indexOf\("Not enough carrots"\)>=0\)return "당근이 부족해요 🥕"/);
  assert.match(html,/아직 해금되지 않은 가구예요/);
  assert.match(html,/보유한 가구만 배치할 수 있어요/);
  var source=html.slice(html.indexOf("function p10Item("),html.indexOf("function openP10PlacementPrompt("));
  var helpers=new Function("state",source+";return {empty:p10EmptySlot,error:p10ErrorMessage};")({p10Items:[]});
  assert.equal(helpers.error({message:"Not enough carrots"}),"당근이 부족해요 🥕");
  assert.equal(helpers.error({message:"Furniture is locked"}),"아직 해금되지 않은 가구예요.");
});

test("purchase offers safe first-empty-slot placement and never overwrites a full room",function(){
  assert.match(html,/function p10EmptySlot\(\)[\s\S]*\['slot_1','slot_2','slot_3'\]\.find/);
  assert.match(html,/내 서재에 배치할까요\?/);
  assert.match(html,/data-p10-place-now/);
  assert.match(html,/data-p10-empty-slot/);
  assert.match(html,/배치 공간이 모두 사용 중이에요/);
  assert.match(html,/data-p10-manage>배치 관리/);
  assert.match(html,/>나중에</);
  assert.doesNotMatch(html,/배치 \+\(index\+1\)/);
  var source=html.slice(html.indexOf("function p10Item("),html.indexOf("function openP10PlacementPrompt("));
  var partial=new Function("state",source+";return p10EmptySlot;")({p10Items:[{slotId:"slot_1"},{slotId:"slot_3"}]});
  var full=new Function("state",source+";return p10EmptySlot;")({p10Items:[{slotId:"slot_1"},{slotId:"slot_2"},{slotId:"slot_3"}]});
  assert.equal(partial(),"slot_2","the first available approved fixed slot is selected");
  assert.equal(full(),null,"a full room never chooses a slot to overwrite");
});

test("owned furniture is managed directly from its shop row",function(){
  assert.doesNotMatch(html,/p10-slot-list|p10-slot-row|data-p10-slot/);
  assert.match(html,/item\.owned&&item\.slotId[\s\S]*label='보관'[\s\S]*data-p10-store/);
  assert.match(html,/else if\(item\.owned\)[\s\S]*label='배치'[\s\S]*data-p10-place/);
  assert.match(html,/내 서재에 배치 중/);
  assert.match(html,/보유 중 · 보관함/);
  assert.match(html,/서재에 자리가 없어요\. 다른 가구를 보관한 뒤 배치해 주세요\./);
  assert.match(html,/p10Repository\.place\(p10Store\.getAttribute\("data-p10-current-slot"\),null\)/);
  assert.match(html,/p10Repository\.place\(autoSlot,autoItem\)/);
});
