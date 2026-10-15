import assert from "node:assert/strict";

const api=process.env.P10_API_URL,key=process.env.P10_ANON_KEY;
assert.ok(api&&key,"local Supabase environment is required");
async function request(path,{token,method="GET",body}={}){
  const response=await fetch(api+path,{method,headers:{apikey:key,Authorization:`Bearer ${token||key}`,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data=text;}
  return {status:response.status,data};
}
const email=`p10-runtime-${Date.now()}@example.test`,password="P10-local-only-86!";
let signed=await request("/auth/v1/signup",{method:"POST",body:{email,password}});
assert.equal(signed.status,200);let token=signed.data.access_token;const userId=signed.data.user.id;assert.ok(token&&userId);

let book=await request("/rest/v1/books",{token,method:"POST",body:{user_id:userId,client_id:"p10-book",title:"P10 QA 책",author:"BOOKTOKKI",total_pages:100,current_page:0,status:"toread"}});
assert.equal(book.status,201);
let books=await request("/rest/v1/books?client_id=eq.p10-book&select=id,revision",{token});
const bookId=books.data[0].id;
async function rpc(name,body,expected=200){const value=await request(`/rest/v1/rpc/${name}`,{token,method:"POST",body});assert.equal(value.status,expected,`${name}: ${JSON.stringify(value.data)}`);return value.data;}
async function state(){return rpc("get_p10_room_state",{});}

let initial=await state();assert.equal(initial[0].balance,0);assert.equal(initial[0].reading_days,0);
let insufficient=await request("/rest/v1/rpc/purchase_p10_furniture",{token,method:"POST",body:{p_furniture_id:"A",p_client_id:"00000000-0000-4000-8000-000000000001"}});assert.equal(insufficient.status,400);assert.match(insufficient.data.message,/Not enough carrots/);
await rpc("record_page",{p_book_id:bookId,p_expected_revision:1,p_log_client_id:"page-1",p_new_page:10,p_log_date:"2026-10-15",p_recorded_at:"2026-10-15T01:00:00Z"});
let afterPage=await state();assert.equal(afterPage[0].balance,1);assert.equal(afterPage[0].reading_days,1);
await rpc("record_page",{p_book_id:bookId,p_expected_revision:2,p_log_client_id:"page-2",p_new_page:20,p_log_date:"2026-10-15",p_recorded_at:"2026-10-15T02:00:00Z"});
assert.equal((await state())[0].balance,1,"only the first positive page progress per day is rewarded");
await rpc("create_book_note_with_reward",{p_book_id:bookId,p_client_id:"note-1",p_text:"첫 북로그",p_page:20,p_created_at:"2026-10-15T02:10:00Z"});
assert.equal((await state())[0].balance,4);
await rpc("create_book_note_with_reward",{p_book_id:bookId,p_client_id:"note-1",p_text:"첫 북로그",p_page:20,p_created_at:"2026-10-15T02:10:00Z"});
assert.equal((await state())[0].balance,4,"lost-response retry cannot duplicate note rewards");
await rpc("create_book_note_with_reward",{p_book_id:bookId,p_client_id:"note-2",p_text:"같은 날 두 번째 북로그",p_page:20,p_created_at:"2026-10-15T02:20:00Z"});
assert.equal((await state())[0].balance,4,"only the first note per day is rewarded");
await rpc("record_page",{p_book_id:bookId,p_expected_revision:3,p_log_client_id:"page-done",p_new_page:100,p_log_date:"2026-10-15",p_recorded_at:"2026-10-15T03:00:00Z"});
assert.equal((await state())[0].balance,14,"first completion adds ten carrots once");

let buy=await rpc("purchase_p10_furniture",{p_furniture_id:"A",p_client_id:"11111111-1111-4111-8111-111111111111"});assert.equal(buy[0].balance,9);
buy=await rpc("purchase_p10_furniture",{p_furniture_id:"A",p_client_id:"11111111-1111-4111-8111-111111111111"});assert.equal(buy[0].balance,9,"duplicate purchase is free");
assert.equal((await state()).find(x=>x.furniture_id==="A").slot_id,null,"buying alone keeps furniture unplaced for the later choice");
let locked=await request("/rest/v1/rpc/purchase_p10_furniture",{token,method:"POST",body:{p_furniture_id:"B",p_client_id:"22222222-2222-4222-8222-222222222222"}});assert.equal(locked.status,403);
await rpc("place_p10_furniture",{p_slot_id:"slot_1",p_furniture_id:"A"});assert.equal((await state()).find(x=>x.furniture_id==="A").slot_id,"slot_1");
await rpc("place_p10_furniture",{p_slot_id:"slot_2",p_furniture_id:"A"});assert.equal((await state()).find(x=>x.furniture_id==="A").slot_id,"slot_2");
let relogin=await request("/auth/v1/token?grant_type=password",{method:"POST",body:{email,password}});assert.equal(relogin.status,200);token=relogin.data.access_token;
assert.equal((await state()).find(x=>x.furniture_id==="A").slot_id,"slot_2","ownership and placement survive re-login");
await rpc("place_p10_furniture",{p_slot_id:"slot_2",p_furniture_id:null});assert.equal((await state()).find(x=>x.furniture_id==="A").slot_id,null);
let notOwned=await request("/rest/v1/rpc/place_p10_furniture",{token,method:"POST",body:{p_slot_id:"slot_1",p_furniture_id:"B"}});assert.equal(notOwned.status,403);
let direct=await request("/rest/v1/p10_carrot_ledger?select=*",{token});assert.ok([401,403,404].includes(direct.status));
let anonymous=await request("/rest/v1/rpc/get_p10_room_state",{method:"POST",body:{}});assert.ok([401,403,404].includes(anonymous.status));
console.log("PASS P10 Local Auth/PostgREST rewards, idempotency, shop, placement and ACL runtime");
