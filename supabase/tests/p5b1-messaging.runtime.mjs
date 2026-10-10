import crypto from "node:crypto";

const api=process.env.LOCAL_SUPABASE_URL;
const anon=process.env.LOCAL_ANON_KEY;
const service=process.env.LOCAL_SERVICE_ROLE_KEY;
if(!api||!anon||!service)throw new Error("Local Supabase URL and keys are required");
const stamp=Date.now(),password=`Local-P5B1-${stamp}!`;

async function request(path,{key=anon,token,method="POST",body}={}){
  const response=await fetch(api+path,{method,headers:{apikey:key,...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch{data=text}return{status:response.status,data};
}
async function rpc(name,token,body={}){return request(`/rest/v1/rpc/${name}`,{token,body});}
function pass(label,condition,detail){if(!condition)throw new Error(`FAIL ${label} ${JSON.stringify(detail)}`);console.log(`PASS ${label}`);}
async function user(label){
  const email=`p5b1-${label}-${stamp}@example.test`;
  const made=await request("/auth/v1/admin/users",{key:service,token:service,body:{email,password,email_confirm:true,user_metadata:{synthetic:true}}});
  pass(`create synthetic ${label}`,made.status===200,made.status);
  const login=await request("/auth/v1/token?grant_type=password",{body:{email,password}});
  pass(`authenticate synthetic ${label}`,login.status===200,login.status);
  await rpc("update_my_social_profile",login.data.access_token,{p_display_name:`메시지 ${label}`,p_intro:"local fixture"});
  return{id:made.data.id,token:login.data.access_token};
}
async function connect(inviter,recipient){const invite=await rpc("create_friend_invite",inviter.token);const accepted=await rpc("accept_friend_invite",recipient.token,{p_token:invite.data});pass("friend connection",accepted.status===200,accepted);return accepted.data;}
async function send(sender,connectionId,body,clientId=crypto.randomUUID()){return rpc("send_friend_message",sender.token,{p_connection_id:connectionId,p_client_id:clientId,p_body:body});}

const [a,b,c]=await Promise.all([user("A"),user("B"),user("C")]);
const ab=await connect(a,b);

for(const table of ["message_preferences","conversation_read_cursors"]){
  const denied=await request(`/rest/v1/${table}?select=*`,{token:a.token,method:"GET"});
  pass(`authenticated direct ${table} denied`,denied.status===401||denied.status===403,denied.status);
  const serviceDenied=await request(`/rest/v1/${table}?select=*`,{key:service,token:service,method:"GET"});
  pass(`service direct ${table} denied`,serviceDenied.status===401||serviceDenied.status===403,serviceDenied.status);
}
const directPreferenceWrite=await request("/rest/v1/message_preferences",{token:a.token,method:"POST",body:{user_id:a.id,receive_messages:false,in_app_notifications:false}});
pass("authenticated direct preference write denied",directPreferenceWrite.status===401||directPreferenceWrite.status===403,directPreferenceWrite.status);
const anonPreferences=await rpc("get_my_message_preferences",null);
pass("anon preference RPC denied",anonPreferences.status===401||anonPreferences.status===403,anonPreferences.status);

const defaults=await rpc("get_my_message_preferences",a.token);
pass("existing user defaults ON with preview OFF",defaults.status===200&&defaults.data[0].receive_messages===true&&defaults.data[0].in_app_notifications===true&&defaults.data[0].preview_message===false,defaults);

const first=await send(b,ab,"첫 메시지");
pass("friend send succeeds",first.status===200,first);
const inboxA=await rpc("get_message_inbox_state",a.token);
pass("server unread counts incoming message",inboxA.status===200&&Number(inboxA.data[0].total_unread)===1&&inboxA.data[0].latest_message_id===first.data[0].id,inboxA);
const listOnly=await rpc("list_friend_conversations",a.token);
pass("conversation list exposes unread without marking read",listOnly.status===200&&Number(listOnly.data[0].unread_count)===1,listOnly);
const afterList=await rpc("get_message_inbox_state",a.token);
pass("list fetch does not advance cursor",Number(afterList.data[0].total_unread)===1,afterList);

const thirdParty=await rpc("mark_friend_conversation_read",c.token,{p_connection_id:ab,p_through_message_id:first.data[0].id});
pass("third party cursor write denied",thirdParty.status===401||thirdParty.status===403,thirdParty);
const senderCannotMark=await rpc("mark_friend_conversation_read",b.token,{p_connection_id:ab,p_through_message_id:first.data[0].id});
pass("sender cannot mark own message as received",senderCannotMark.status===401||senderCannotMark.status===403,senderCannotMark);
const marked=await rpc("mark_friend_conversation_read",a.token,{p_connection_id:ab,p_through_message_id:first.data[0].id});
pass("recipient marks visible message read",marked.status===200,marked);
const readInbox=await rpc("get_message_inbox_state",a.token);
pass("server cursor clears unread across devices",Number(readInbox.data[0].total_unread)===0,readInbox);

const disabled=await rpc("update_my_message_preferences",a.token,{p_receive_messages:false,p_in_app_notifications:true,p_preview_message:true});
pass("receive preference OFF and preview ON stored",disabled.status===200&&disabled.data[0].receive_messages===false&&disabled.data[0].preview_message===true,disabled);
const blockedSend=await send(b,ab,"거부되어야 하는 메시지");
pass("receive OFF rejects insert with generic denial",(blockedSend.status===401||blockedSend.status===403)&&!JSON.stringify(blockedSend.data).match(/preference|receive|수신/i),blockedSend);
const unchanged=await rpc("get_message_inbox_state",a.token);
pass("receive OFF preserves existing unread state",Number(unchanged.data[0].total_unread)===0,unchanged);

const id=crypto.randomUUID();
await rpc("update_my_message_preferences",a.token,{p_receive_messages:true,p_in_app_notifications:true,p_preview_message:false});
const success=await send(b,ab,"재시도 메시지",id);pass("idempotency fixture stored",success.status===200,success);
await rpc("update_my_message_preferences",a.token,{p_receive_messages:false,p_in_app_notifications:false,p_preview_message:true});
const retry=await send(b,ab,"재시도 메시지",id);
pass("lost-response retry returns stored row after receive OFF",retry.status===200&&retry.data[0].id===success.data[0].id,retry);
const conflict=await send(b,ab,"바뀐 내용",id);
pass("same client id with changed body conflicts",conflict.status===409,conflict);

const bPrefs=await rpc("get_my_message_preferences",b.token);
pass("preferences are user-isolated",bPrefs.status===200&&bPrefs.data[0].receive_messages===true&&bPrefs.data[0].in_app_notifications===true&&bPrefs.data[0].preview_message===false,bPrefs);

console.log("LOCAL_P5B1_MESSAGING_COMPLETE");
