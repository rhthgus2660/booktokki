const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261008232749_p5b_conversation.sql"), "utf8");
const repository = require(path.join(root, "conversation-repository.js"));
const pollingModule = require(path.join(root, "conversation-polling.js"));

test("P5-B UI exposes conversations only through authenticated friend surfaces", () => {
  assert.match(html, /data-open-conversation=/);
  assert.match(html, /id="view-conversations"/);
  assert.match(html, /id="view-conversation"/);
  assert.match(html, /id="conversationForm"/);
  assert.match(html, /친구 연결이 종료되어 지난 대화만 볼 수 있어요/);
  assert.match(html, /conversation-readonly-label/);
  assert.doesNotMatch(html, /메시지 보내기<\/button><button[^>]+disabled/);
});

test("conversation repository uses only P5-B RPCs", async () => {
  const calls = [];
  const client = { rpc(name, params){ calls.push({name, params}); return Promise.resolve({data:name === "send_friend_message" ? [{id:"m1",body:"안녕",created_at:"2026-10-09T00:00:00Z",sender_is_me:true}] : [],error:null}); } };
  const api = repository.create(client);
  await api.list();
  await api.messages("00000000-0000-0000-0000-000000000001");
  const sent = await api.send("00000000-0000-0000-0000-000000000001", " 안녕 ", "00000000-0000-4000-8000-000000000002");
  assert.deepEqual(calls.map(item => item.name), ["list_friend_conversations", "get_friend_messages", "send_friend_message"]);
  assert.equal(calls[2].params.p_body, "안녕");
  assert.equal(sent.body, "안녕");
  assert.equal(sent.senderIsMe, true);
  assert.equal(sent.canSend, true);
});

test("message report uses the selected connection and message without profile lookup", async () => {
  const calls=[];
  const client={rpc(name,params){calls.push({name,params});return Promise.resolve({data:"report-1",error:null});}};
  const api=repository.create(client);
  const id=await api.report("connection-1","message-1","harassment"," 설명 ");
  assert.equal(id,"report-1");
  assert.deepEqual(calls,[{name:"report_friend_message",params:{p_connection_id:"connection-1",p_message_id:"message-1",p_category:"harassment",p_detail:"설명"}}]);
});

test("message input is bounded and single-paragraph", () => {
  assert.equal(repository.normalizeBody("  책 이야기  "), "책 이야기");
  assert.throws(() => repository.normalizeBody(""), /입력/);
  assert.throws(() => repository.normalizeBody("a\nb"), /줄바꿈/);
  assert.throws(() => repository.normalizeBody("\u200b\u2060\ufeff"), /입력/);
  assert.throws(() => repository.normalizeBody("가".repeat(1001)), /1000/);
});

test("lost responses reuse clientId until body changes or send succeeds", async () => {
  let generated = 0;
  const makeId = () => `client-${++generated}`;
  const first = repository.sendAttempt(null, "connection-1", " 같은 문장 ", makeId);
  const retry = repository.sendAttempt(first, "connection-1", "같은 문장", makeId);
  const edited = repository.sendAttempt(first, "connection-1", "수정한 문장", makeId);
  const afterSuccess = repository.sendAttempt(null, "connection-1", "같은 문장", makeId);
  assert.equal(retry.clientId, first.clientId);
  assert.notEqual(edited.clientId, first.clientId);
  assert.notEqual(afterSuccess.clientId, first.clientId);
  assert.equal(generated, 3);
  assert.match(html, /if\(state\.conversationSending\|\|!conversationRepository/);
  assert.match(html, /state\.conversationSendAttempt=null/);
});

test("latest message permission overrides stale conversation list permission", () => {
  assert.equal(repository.resolveCanSend([{canSend:false}], {canSend:true}, true), false);
  assert.equal(repository.resolveCanSend([{canSend:true}], {canSend:false}, false), true);
  assert.equal(repository.resolveCanSend([], {canSend:false}, true), false);
  assert.match(html, /error&&error\.code==="42501"[\s\S]*conversationCanSend=false/);
  assert.match(html, /Object\.assign\(\{\},item,\{canSend:false\}\)/);
});

test("migration enforces friendship, two-way blocks, idempotency, rate limit and private table ACL", () => {
  assert.match(sql, /revoke all on table public\.friend_messages from public,anon,authenticated,service_role/i);
  assert.match(sql, /mirror\.user_id=mine\.friend_user_id[\s\S]*mirror\.friend_user_id=mine\.user_id/i);
  assert.match(sql, /b\.blocker_id=uid and b\.blocked_id=fid/i);
  assert.match(sql, /b\.blocker_id=fid and b\.blocked_id=uid/i);
  assert.match(sql, /friend_messages_sender_client_unique unique\(sender_id,client_id\)/i);
  assert.match(sql, /Too many messages/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /sender_display_name text not null/i);
  assert.match(sql, /recipient_display_name text not null/i);
  assert.match(sql, /grant execute .* to authenticated/is);
  assert.match(sql, /chr\(8203\)[\s\S]*chr\(65279\)/i);
});

test("message report evidence is participant-checked, immutable and operator-only", () => {
  assert.match(sql, /create table public\.conversation_report_evidence/i);
  assert.match(sql, /report_id uuid primary key references public\.social_reports\(id\) on delete cascade/i);
  assert.match(sql, /message_id uuid not null unique/i);
  assert.match(sql, /revoke all on table public\.conversation_report_evidence from public,anon,authenticated,service_role/i);
  assert.match(sql, /grant select on table public\.conversation_report_evidence to service_role/i);
  assert.match(sql, /create table public\.conversation_report_receipts/i);
  assert.match(sql, /unique\(reporter_id,message_id\)/i);
  assert.match(sql, /create function public\.report_friend_message/i);
  assert.match(sql, /m\.id=p_message_id and m\.connection_id=p_connection_id[\s\S]*m\.recipient_id=uid and m\.sender_id<>uid/i);
  assert.match(sql, /reported_message\.sender_display_name,null/i);
  const reportFunction=sql.match(/create function public\.report_friend_message[\s\S]*?end \$\$;/i)?.[0]||"";
  assert.doesNotMatch(reportFunction,/friend_profiles|app_presence/i);
  assert.doesNotMatch(sql,/grant (insert|update|delete|truncate)[^;]*conversation_report_evidence/i);
  assert.match(sql,/from public\.conversation_report_receipts receipt[\s\S]*receipt\.message_id=p_message_id/i);
});

test("message report retention uses an hourly service-only purge with a maximum 90-day bound", () => {
  const purgeFunction=sql.match(/create function public\.purge_expired_conversation_report_evidence[\s\S]*?end \$\$;/i)?.[0]||"";
  assert.match(purgeFunction,/statement_timestamp\(\)-interval '89 days 23 hours'/i);
  assert.match(purgeFunction,/r\.created_at<=cutoff/i);
  assert.match(purgeFunction,/delete from public\.conversation_report_evidence/i);
  assert.match(purgeFunction,/remaining_expired_count/i);
  assert.doesNotMatch(purgeFunction,/p_cutoff|friend_messages|delete from public\.social_reports/i);
  assert.match(sql,/revoke all on function public\.purge_expired_conversation_report_evidence\(\) from public,anon,authenticated/i);
  assert.match(sql,/grant execute on function public\.purge_expired_conversation_report_evidence\(\) to service_role/i);
  assert.match(sql,/create extension if not exists pg_cron/i);
  assert.match(sql,/p5b-report-evidence-retention-hourly'[\s\S]*'7 \* \* \* \*'/i);
  assert.match(sql,/p5b-report-evidence-retention-watchdog'[\s\S]*'17 \* \* \* \*'/i);
  assert.match(sql,/last_success<statement_timestamp\(\)-interval '2 hours'/i);
  assert.match(sql,/last_success is null and installed_at>statement_timestamp\(\)-interval '2 hours' then return/i);
});

test("received messages expose a confirmed privacy-aware report flow", () => {
  assert.match(html,/item\.senderIsMe\?'':'<button class="conversation-message-report"/);
  assert.match(html,/data-conversation-report-submit/);
  assert.match(html,/신고한 메시지 본문, 작성 시각과 신고 사유가 증거로 저장되며 접수 후 최대 90일 보관돼요/);
  assert.match(html,/일반 대화 원본은 계정 삭제 정책을 따르며, 신고 증거는 접수 후 최대 90일 보관한 뒤 자동 삭제돼요/);
  assert.match(html,/상대방에게는 알리지 않아요/);
  assert.match(html,/conversationRepository\.report\(messageReportConnection,messageReportId/);
});

test("conversation rendering preserves focus, de-duplicates messages and paginates", () => {
  assert.match(html, /document\.activeElement&&document\.activeElement\.id==="conversationInput"/);
  assert.match(html, /focus\(\{preventScroll:true\}\)/);
  assert.match(html, /byId\[item\.id\]/);
  assert.match(html, /data-conversation-older/);
  assert.match(html, /conversationNearBottom\(\)/);
  assert.match(html, /scrollLatest:initialLoad\|\|!!options\.showLoading\|\|wasNearBottom/);
});

test("disconnect or block preserves participant-only read access without current profile joins", () => {
  assert.match(sql, /m\.sender_id=uid or m\.recipient_id=uid/i);
  assert.match(sql, /if not send_allowed and not exists/i);
  assert.match(sql, /last_message\.recipient_display_name else last_message\.sender_display_name/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.friend_messages/i);
  assert.doesNotMatch(sql, /connection_id\s+uuid[^,]*references\s+public\.friend_links/i);
});

test("10-second polling is visible-route scoped, non-overlapping and restartable", async () => {
  let active = true, visible = true, calls = 0, nextTimer = 0;
  const timers = new Map();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const polling = pollingModule.create({
    intervalMs: 10000,
    isActive: () => active,
    isVisible: () => visible,
    poll: () => { calls += 1; return calls === 1 ? pending : Promise.resolve(true); },
    setTimer(fn, ms){ assert.equal(ms, 10000); const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer(id){ timers.delete(id); }
  });
  const first = polling.start();
  const duplicate = polling.run();
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(polling.hasInflight(), true);
  release(true);
  await Promise.all([first, duplicate]);
  assert.equal(timers.size, 1);
  visible = false;
  await polling.visibilityChanged();
  assert.equal(timers.size, 0);
  visible = true;
  await polling.visibilityChanged();
  assert.equal(calls, 2);
  assert.equal(timers.size, 1);
  active = false;
  polling.stop();
  assert.equal(timers.size, 0);
});

test("stopped polling cannot schedule after an old request settles", async () => {
  let active = true, visible = true, calls = 0, release;
  const timers = new Map();
  const pending = new Promise(resolve => { release = resolve; });
  const polling = pollingModule.create({
    intervalMs: 10000,
    isActive: () => active,
    isVisible: () => visible,
    poll: () => { calls += 1; return pending; },
    setTimer(fn){ const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimer(id){ timers.delete(id); }
  });
  const run = polling.start();
  await Promise.resolve();
  assert.equal(calls, 1);
  active = false;
  polling.stop();
  release(true);
  await run;
  assert.equal(timers.size, 0);
});

test("a new session starts a fresh poll while the prior session request is stale", async () => {
  let calls = 0, releaseOld;
  const oldRequest = new Promise(resolve => { releaseOld = resolve; });
  const polling = pollingModule.create({
    isActive: () => true,
    isVisible: () => true,
    poll: () => { calls += 1; return calls === 1 ? oldRequest : Promise.resolve(true); },
    setTimer(){ return 1; },
    clearTimer(){}
  });
  const oldRun = polling.start();
  await Promise.resolve();
  polling.stop();
  const newRun = polling.start();
  await Promise.resolve();
  assert.equal(calls, 2);
  await newRun;
  releaseOld(true);
  await oldRun;
});
