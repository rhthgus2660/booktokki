import crypto from "node:crypto";
import {execFileSync} from "node:child_process";

const api=process.env.LOCAL_SUPABASE_URL,anon=process.env.LOCAL_ANON_KEY,service=process.env.LOCAL_SERVICE_ROLE_KEY;
const db=process.env.LOCAL_DB_URL,psql=process.env.LOCAL_PSQL_PATH;
if(!api||!anon||!service)throw new Error("Local Supabase URL and keys are required");
const stamp=Date.now(),password=`Local-P6-${stamp}!`;
async function request(path,{key=anon,token,method="POST",body,prefer}={}){
  const response=await fetch(api+path,{method,headers:{apikey:key,...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{"Content-Type":"application/json"}:{}),...(prefer?{Prefer:prefer}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch{data=text}return{status:response.status,data};
}
async function rpc(name,token,body={}){return request(`/rest/v1/rpc/${name}`,{token,body});}
function pass(label,condition,detail){if(!condition)throw new Error(`FAIL ${label} ${JSON.stringify(detail)}`);console.log(`PASS ${label}`);}
async function user(label){
  const email=`p6-${label}-${stamp}@example.test`;
  const made=await request("/auth/v1/admin/users",{key:service,token:service,body:{email,password,email_confirm:true,user_metadata:{synthetic:true}}});
  pass(`create synthetic ${label}`,made.status===200,made.status);
  const login=await request("/auth/v1/token?grant_type=password",{body:{email,password}});pass(`authenticate ${label}`,login.status===200,login.status);
  return{id:made.data.id,token:login.data.access_token};
}
const [a,b]=await Promise.all([user("A"),user("B")]);
for(const table of ["p6_reaction_candidates","p6_character_events"]){
  const denied=await request(`/rest/v1/${table}?select=*`,{token:a.token,method:"GET"});pass(`authenticated direct ${table} denied`,denied.status===401||denied.status===403,denied);
  const serviceWrite=await request(`/rest/v1/${table}`,{key:service,token:service,body:{}});pass(`service direct ${table} write denied`,serviceWrite.status===401||serviceWrite.status===403,serviceWrite);
}
const anonClaim=await rpc("claim_p6_reaction",null);pass("anon claim denied",anonClaim.status===401||anonClaim.status===403,anonClaim);
const anonDismiss=await rpc("dismiss_p6_reaction",null,{p_reaction_id:crypto.randomUUID(),p_claim_token:crypto.randomUUID(),p_reason:"policy_suppressed"});pass("anon dismiss denied",anonDismiss.status===401||anonDismiss.status===403,anonDismiss);
const bookClient=crypto.randomUUID();
const book=await request("/rest/v1/books?select=*",{token:a.token,body:{user_id:a.id,client_id:bookClient,title:"Synthetic",author:"Test",total_pages:100,current_page:0,status:"toread"},prefer:"return=representation"});
pass("book insert succeeds",book.status===201&&book.data.length===1,book);
const firstBookClaim=await rpc("claim_p6_reaction",a.token);pass("first book candidate",firstBookClaim.status===200&&firstBookClaim.data[0].reaction_kind==="first_book",firstBookClaim);
const wrongDismiss=await rpc("dismiss_p6_reaction",a.token,{p_reaction_id:firstBookClaim.data[0].reaction_id,p_claim_token:crypto.randomUUID(),p_reason:"policy_suppressed"});pass("dismiss requires the active claim token",wrongDismiss.status===200&&wrongDismiss.data===false,wrongDismiss);
const dismisses=await Promise.all([rpc("dismiss_p6_reaction",a.token,{p_reaction_id:firstBookClaim.data[0].reaction_id,p_claim_token:firstBookClaim.data[0].claim_token,p_reason:"policy_suppressed"}),rpc("dismiss_p6_reaction",a.token,{p_reaction_id:firstBookClaim.data[0].reaction_id,p_claim_token:firstBookClaim.data[0].claim_token,p_reason:"policy_suppressed"})]);
pass("concurrent policy dismissal resolves once",dismisses.filter(x=>x.status===200&&x.data===true).length===1,dismisses);
const suppressedRow=await request(`/rest/v1/p6_reaction_candidates?id=eq.${firstBookClaim.data[0].reaction_id}&select=resolution,displayed_at,completed_at`,{key:service,token:service,method:"GET"});
pass("suppression does not distort displayed or completed metrics",suppressedRow.status===200&&suppressedRow.data[0].resolution==="policy_suppressed"&&!suppressedRow.data[0].displayed_at&&!suppressedRow.data[0].completed_at,suppressedRow);

const firstLogId=crypto.randomUUID(),nowIso=new Date().toISOString();
const firstPage=await rpc("record_page",a.token,{p_book_id:book.data[0].id,p_expected_revision:book.data[0].revision,p_log_client_id:firstLogId,p_new_page:10,p_log_date:nowIso.slice(0,10),p_recorded_at:nowIso});
pass("positive page write succeeds",firstPage.status===200,firstPage);
const firstPositive=await rpc("claim_p6_reaction",a.token);pass("first positive candidate outranks lower work",firstPositive.status===200&&firstPositive.data[0].reaction_kind==="first_positive_page",firstPositive);
await rpc("mark_p6_reaction_displayed",a.token,{p_reaction_id:firstPositive.data[0].reaction_id,p_claim_token:firstPositive.data[0].claim_token});
await rpc("complete_p6_reaction",a.token,{p_reaction_id:firstPositive.data[0].reaction_id,p_claim_token:firstPositive.data[0].claim_token});

const fourDaysAgo=new Date(Date.now()-4*86400000).toISOString();
if(db&&psql)execFileSync(psql,[db,"-v","ON_ERROR_STOP=1","-c",`update public.reading_logs set recorded_at='${fourDaysAgo}' where user_id='${a.id}' and client_id='${firstLogId}'`],{stdio:"ignore"});

const latest=await request(`/rest/v1/books?id=eq.${book.data[0].id}&select=*`,{token:a.token,method:"GET"});
const returned=await rpc("record_page",a.token,{p_book_id:book.data[0].id,p_expected_revision:latest.data[0].revision,p_log_client_id:crypto.randomUUID(),p_new_page:20,p_log_date:new Date().toISOString().slice(0,10),p_recorded_at:new Date().toISOString()});
pass("return page write succeeds",returned.status===200,returned);
const returnClaim=await rpc("claim_p6_reaction",a.token);pass("three-day return candidate",returnClaim.status===200&&returnClaim.data[0].reaction_kind==="return",returnClaim);
await rpc("dismiss_p6_reaction",a.token,{p_reaction_id:returnClaim.data[0].reaction_id,p_claim_token:returnClaim.data[0].claim_token,p_reason:"policy_suppressed"});

const beforeDone=await request(`/rest/v1/books?id=eq.${book.data[0].id}&select=*`,{token:a.token,method:"GET"});
const beforeFailure=await request(`/rest/v1/p6_reaction_candidates?user_id=eq.${a.id}&select=id`,{key:service,token:service,method:"GET"});
const failedWrite=await rpc("record_page",a.token,{p_book_id:book.data[0].id,p_expected_revision:-1,p_log_client_id:crypto.randomUUID(),p_new_page:99,p_log_date:new Date().toISOString().slice(0,10),p_recorded_at:new Date().toISOString()});
pass("failed Cloud write is rejected",failedWrite.status===409,failedWrite);
const afterFailure=await request(`/rest/v1/p6_reaction_candidates?user_id=eq.${a.id}&select=id`,{key:service,token:service,method:"GET"});
pass("failed Cloud write creates no candidate",afterFailure.status===200&&afterFailure.data.length===beforeFailure.data.length,afterFailure);
await rpc("record_page",a.token,{p_book_id:book.data[0].id,p_expected_revision:beforeDone.data[0].revision,p_log_client_id:crypto.randomUUID(),p_new_page:100,p_log_date:new Date().toISOString().slice(0,10),p_recorded_at:new Date().toISOString()});
const claims=await Promise.all([rpc("claim_p6_reaction",a.token),rpc("claim_p6_reaction",a.token)]);
pass("concurrent Home claims return completion once",claims.filter(x=>x.status===200&&x.data.length&&x.data[0].reaction_kind==="completion").length===1,claims);
if(db&&psql){
  execFileSync(psql,[db,"-v","ON_ERROR_STOP=1","-c",`update public.p6_reaction_candidates set claimed_until=now()-interval '1 second' where user_id='${a.id}' and reaction_kind='completion' and displayed_at is null`],{stdio:"ignore"});
  const reclaimed=await rpc("claim_p6_reaction",a.token);pass("expired unseen claim is retried after app exit",reclaimed.status===200&&reclaimed.data[0].reaction_kind==="completion",reclaimed);
  const dismissed=await rpc("dismiss_p6_reaction",a.token,{p_reaction_id:reclaimed.data[0].reaction_id,p_claim_token:reclaimed.data[0].claim_token,p_reason:"policy_suppressed"});pass("completion candidate can be resolved without a second reaction",dismissed.status===200&&dismissed.data===true,dismissed);
}
const completionRows=await request(`/rest/v1/p6_reaction_candidates?user_id=eq.${a.id}&reaction_kind=eq.completion&select=id,resolution,displayed_at`,{key:service,token:service,method:"GET"});
pass("completion transition creates one durable non-displayed resolution",completionRows.status===200&&completionRows.data.length===1&&completionRows.data[0].resolution==="policy_suppressed"&&!completionRows.data[0].displayed_at,completionRows);

const staleBook=await request("/rest/v1/books?select=*",{token:b.token,body:{user_id:b.id,client_id:crypto.randomUUID(),title:"Stale",author:"Test",total_pages:10,current_page:0,status:"toread"},prefer:"return=representation"});
pass("stale fixture book insert succeeds",staleBook.status===201,staleBook);
if(db&&psql)execFileSync(psql,[db,"-v","ON_ERROR_STOP=1","-c",`update public.p6_reaction_candidates set source_occurred_at=now()-interval '25 hours' where user_id='${b.id}'`],{stdio:"ignore"});
const other=await rpc("claim_p6_reaction",b.token);pass("account reaction state isolated",other.status===200&&Array.isArray(other.data)&&other.data.length===0,other);
const staleRows=await request(`/rest/v1/p6_reaction_candidates?user_id=eq.${b.id}&select=resolution,displayed_at,completed_at`,{key:service,token:service,method:"GET"});
pass("24-hour stale candidate resolves without display metrics",staleRows.status===200&&staleRows.data[0].resolution==="stale"&&!staleRows.data[0].displayed_at&&!staleRows.data[0].completed_at,staleRows);
const event=await rpc("record_p6_character_event",a.token,{p_event_id:crypto.randomUUID(),p_event_type:"rabbit_tapped",p_reaction_kind:"contextual",p_cta_type:null,p_session_id:"runtime-session"});
pass("content-free character event accepted",event.status===200,event);
console.log("LOCAL_P6_ACTIVATION_COMPLETE");
