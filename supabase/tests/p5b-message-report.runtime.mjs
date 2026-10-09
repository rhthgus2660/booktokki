import crypto from "node:crypto";
import {execFileSync} from "node:child_process";

const api=process.env.LOCAL_SUPABASE_URL||"http://127.0.0.1:54321";
const anon=process.env.LOCAL_ANON_KEY;
const service=process.env.LOCAL_SERVICE_ROLE_KEY;
const dbUrl=process.env.LOCAL_DB_URL;
if(!anon||!service||!dbUrl)throw new Error("Local Supabase keys and DB URL are required");
const stamp=Date.now(),password=`Local-P5B-report-${stamp}!`;

async function request(path,{key=anon,token,method="POST",body}={}){
  const response=await fetch(api+path,{method,headers:{apikey:key,...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch{data=text}return{status:response.status,data};
}
async function user(label){
  const email=`p5b-report-${label}-${stamp}@example.test`;
  const made=await request("/auth/v1/admin/users",{key:service,token:service,body:{email,password,email_confirm:true,user_metadata:{synthetic:true}}});
  const login=await request("/auth/v1/token?grant_type=password",{body:{email,password}});
  await rpc("update_my_social_profile",login.data.access_token,{p_display_name:`신고 ${label}`,p_intro:"local fixture"});
  return{id:made.data.id,token:login.data.access_token};
}
async function rpc(name,token,body={}){return request(`/rest/v1/rpc/${name}`,{token,body});}
function pass(label,condition,detail){if(!condition)throw new Error(`FAIL ${label} ${JSON.stringify(detail)}`);console.log(`PASS ${label}`);}
async function connect(inviter,recipient){const invite=await rpc("create_friend_invite",inviter.token);const accepted=await rpc("accept_friend_invite",recipient.token,{p_token:invite.data});pass("friend connection",accepted.status===200,accepted);return accepted.data;}
async function send(sender,connectionId,body){const result=await rpc("send_friend_message",sender.token,{p_connection_id:connectionId,p_client_id:crypto.randomUUID(),p_body:body});pass("message sent",result.status===200,result);return result.data[0];}
async function report(reporter,connectionId,messageId,detail="증거 확인 요청"){return rpc("report_friend_message",reporter.token,{p_connection_id:connectionId,p_message_id:messageId,p_category:"harassment",p_detail:detail});}

const [a,b,c]=await Promise.all([user("A"),user("B"),user("C")]);
const ab=await connect(a,b);
const received=await send(b,ab,"신고 대상 메시지");
const mine=await send(a,ab,"내가 보낸 메시지");

const normal=await report(a,ab,received.id);
pass("normal message report",normal.status===200,normal);
const duplicate=await report(a,ab,received.id);
pass("duplicate report is idempotent",duplicate.status===200&&duplicate.data===normal.data,duplicate);
const changedDuplicate=await report(a,ab,received.id,"다른 설명");
pass("changed duplicate rejected",changedDuplicate.status===409,changedDuplicate);
const own=await report(a,ab,mine.id);
pass("own message cannot be reported",own.status===401||own.status===403,own);
const stranger=await report(c,ab,received.id);
pass("third party cannot report",stranger.status===401||stranger.status===403,stranger);
const fakeConnection=await report(a,crypto.randomUUID(),received.id);
pass("connection and message mismatch denied",fakeConnection.status===401||fakeConnection.status===403,fakeConnection);

const beforeDisconnect=await send(b,ab,"친구 끊기 전 메시지");
const disconnected=await rpc("disconnect_friend_connection",a.token,{p_connection_id:ab});
pass("disconnect succeeds",disconnected.status===200&&disconnected.data===true,disconnected);
const afterDisconnect=await report(a,ab,beforeDisconnect.id,"친구 끊기 후 신고");
pass("report after disconnect",afterDisconnect.status===200,afterDisconnect);

const ab2=await connect(a,b);
const beforeBlock=await send(b,ab2,"차단 전 메시지");
const blocked=await rpc("block_friend_connection",a.token,{p_connection_id:ab2});
pass("block succeeds",blocked.status===200&&blocked.data===true,blocked);
const afterBlock=await report(a,ab2,beforeBlock.id,"차단 후 신고");
pass("report after block",afterBlock.status===200,afterBlock);

const ac=await connect(a,c);
const p5aReport=await rpc("report_friend_connection",a.token,{p_connection_id:ac,p_category:"other",p_detail:"P5-A regression"});
pass("existing P5-A report still works",p5aReport.status===200,p5aReport);

const authDirect=await request("/rest/v1/conversation_report_evidence?select=*",{token:a.token,method:"GET"});
pass("authenticated evidence access denied",authDirect.status===401||authDirect.status===403,authDirect.status);
const evidence=await request(`/rest/v1/conversation_report_evidence?report_id=eq.${normal.data}&select=*`,{key:service,token:service,method:"GET"});
pass("service role evidence select",evidence.status===200&&evidence.data.length===1,evidence);
pass("evidence snapshot matches message",evidence.data[0].message_id===received.id&&evidence.data[0].message_body==="신고 대상 메시지"&&!!evidence.data[0].message_created_at,evidence.data[0]);
const patch=await request(`/rest/v1/conversation_report_evidence?report_id=eq.${normal.data}`,{key:service,token:service,method:"PATCH",body:{message_body:"변조"}});
pass("service role evidence update denied",patch.status===401||patch.status===403,patch.status);
const deletion=await request(`/rest/v1/conversation_report_evidence?report_id=eq.${normal.data}`,{key:service,token:service,method:"DELETE"});
pass("service role evidence delete denied",deletion.status===401||deletion.status===403,deletion.status);

execFileSync("/Users/yunz/.local/booktokki-tools/bin/psql",[
  dbUrl,
  "-c",`update public.social_reports set created_at=case id
    when '${normal.data}'::uuid then now()-interval '91 days'
    when '${afterDisconnect.data}'::uuid then now()-interval '89 days 23 hours'
    when '${afterBlock.data}'::uuid then now()-interval '89 days'
    else created_at end
    where id in ('${normal.data}'::uuid,'${afterDisconnect.data}'::uuid,'${afterBlock.data}'::uuid);`
],{stdio:"ignore"});
const authPurge=await rpc("purge_expired_conversation_report_evidence",a.token);
pass("authenticated retention purge denied",authPurge.status===401||authPurge.status===403,authPurge.status);
const purged=await request("/rest/v1/rpc/purge_expired_conversation_report_evidence",{key:service,token:service,body:{}});
const purgeResult=Array.isArray(purged.data)?purged.data[0]:purged.data;
pass("service role retention purge",purged.status===200&&Number(purgeResult.deleted_count)===2&&Number(purgeResult.remaining_expired_count)===0,purged);
const retentionRows=await request(`/rest/v1/conversation_report_evidence?report_id=in.(${normal.data},${afterDisconnect.data},${afterBlock.data})&select=report_id`,{key:service,token:service,method:"GET"});
pass("hourly cutoff removes boundary without deleting fresh evidence",retentionRows.status===200&&retentionRows.data.length===1&&retentionRows.data[0].report_id===afterBlock.data,retentionRows);
const reportAfterExpiry=await report(a,ab,received.id);
pass("expired evidence cannot restart retention by duplicate report",reportAfterExpiry.status===200&&reportAfterExpiry.data===normal.data,reportAfterExpiry);
const evidenceAfterDuplicate=await request(`/rest/v1/conversation_report_evidence?report_id=eq.${normal.data}&select=report_id`,{key:service,token:service,method:"GET"});
pass("duplicate report does not recreate expired evidence",evidenceAfterDuplicate.status===200&&evidenceAfterDuplicate.data.length===0,evidenceAfterDuplicate);
const retainedReports=await request(`/rest/v1/social_reports?id=in.(${normal.data},${afterDisconnect.data},${afterBlock.data})&select=id`,{key:service,token:service,method:"GET"});
pass("evidence purge preserves report metadata",retainedReports.status===200&&retainedReports.data.length===3,retainedReports);

const fullwidth=await rpc("send_friend_message",a.token,{p_connection_id:ac,p_client_id:crypto.randomUUID(),p_body:"　　"});
pass("fullwidth whitespace-only message rejected",fullwidth.status===400,fullwidth);

execFileSync("/Users/yunz/.local/booktokki-tools/bin/psql",[dbUrl,"-c","select public.assert_conversation_report_retention_health();"],{stdio:"ignore"});
pass("watchdog allows initial first-run grace",true);

const deleted=await request(`/auth/v1/admin/users/${b.id}`,{key:service,token:service,method:"DELETE"});
pass("reported account delete",deleted.status===200,deleted);
const afterDelete=await request(`/rest/v1/conversation_report_evidence?report_id=eq.${normal.data}&select=*`,{key:service,token:service,method:"GET"});
pass("current cascade removes linked report evidence",afterDelete.status===200&&afterDelete.data.length===0,afterDelete);

console.log("LOCAL_P5B_MESSAGE_REPORT_COMPLETE");
