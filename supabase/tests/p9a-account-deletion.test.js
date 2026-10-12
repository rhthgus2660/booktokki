"use strict";
var test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var root=path.join(__dirname,"../..");
var sql=fs.readFileSync(path.join(root,"supabase/migrations/20261011113246_p9a_exchange_reading_phase1.sql"),"utf8");
var edge=fs.readFileSync(path.join(root,"supabase/functions/delete-account/index.ts"),"utf8");
var html=fs.readFileSync(path.join(root,"index.html"),"utf8");

test("account deletion preserves pseudonymized P9 messages while membership cascades",function(){
  assert.match(sql,/sender_id uuid references auth\.users\(id\) on delete set null/);
  assert.match(sql,/sender_display_name='탈퇴한 사용자'/);
  assert.match(sql,/before delete on auth\.users/);
  assert.match(sql,/user_id uuid not null references auth\.users\(id\) on delete cascade/);
  assert.doesNotMatch(sql,/foreign key \(room_id,sender_id\)/);
  assert.match(sql,/before insert on public\.exchange_reading_messages[\s\S]*p9a_guard_exchange_content_write/);
});

test("report parties become nullable but protected evidence remains immutable",function(){
  assert.match(sql,/social_reports_reporter_id_fkey foreign key \(reporter_id\) references auth\.users\(id\) on delete set null/);
  assert.match(sql,/social_reports_reported_user_id_fkey foreign key \(reported_user_id\) references auth\.users\(id\) on delete set null/);
  assert.match(sql,/revoke all on table public\.exchange_reading_report_evidence from public,anon,authenticated,service_role/);
  assert.doesNotMatch(sql,/grant (?:update|delete|truncate) on table public\.exchange_reading_report_evidence/i);
  assert.match(sql,/review_status in\('resolved','dismissed'\)/);
});

test("trusted deletion endpoint deletes only the current authenticated user",function(){
  assert.match(edge,/\/auth\/v1\/user/);
  assert.match(edge,/confirmation !== "DELETE"/);
  assert.match(edge,/\/auth\/v1\/admin\/users\//);
  assert.match(edge,/encodeURIComponent\(user\.id\)/);
  assert.doesNotMatch(edge,/providerAccessToken|KAKAO_TOKEN_INFO_URL|prompt:\s*["']login/);
  assert.match(edge,/allowedReasons/);
  assert.match(edge,/record_account_deletion_reason/);
  assert.equal((edge.match(/method: "DELETE"/g)||[]).length,1);
  assert.doesNotMatch(edge,/SUPABASE_SERVICE_ROLE_KEY[^\n]*json|serviceKey[^\n]*body/);
});

test("optional deletion reasons are stored only as a protected aggregate",function(){
  assert.match(sql,/create table public\.account_deletion_reason_daily/);
  assert.match(sql,/primary key\(deletion_date,reason\)/);
  assert.match(sql,/revoke all on table public\.account_deletion_reason_daily from public,anon,authenticated,service_role/);
  assert.match(sql,/create function public\.record_account_deletion_reason\(p_reason text\)/);
  assert.match(sql,/grant execute on function public\.record_account_deletion_reason\(text\) to service_role/);
  assert.doesNotMatch(sql,/account_deletion_reason_daily[\s\S]{0,300}(?:user_id|email|display_name|free_text)/i);
});

test("P5 and P9 evidence share a hold-aware maximum-90-day purge",function(){
  assert.match(sql,/create or replace function public\.purge_expired_conversation_report_evidence/);
  assert.match(sql,/delete from public\.conversation_report_evidence/);
  assert.match(sql,/delete from public\.exchange_reading_report_evidence/);
  assert.match(sql,/interval '89 days 23 hours'/);
  assert.match(sql,/evidence_hold_released_at is null/);
  assert.match(sql,/create function public\.set_report_evidence_hold/);
  assert.match(sql,/create function public\.release_report_evidence_hold/);
  assert.doesNotMatch(sql,/grant execute on function public\.set_report_evidence_hold[^;]+ to authenticated/i);
});

test("MY account deletion UI discloses retained data and uses current session confirmation",function(){
  assert.match(html,/MY[\s\S]*계정 관리[\s\S]*회원 탈퇴/);
  assert.match(html,/교환독서 그룹 메시지 본문은 남고/);
  assert.match(html,/메시지 본문이나 대화 맥락만으로 작성자를 알아볼 가능성/);
  assert.match(html,/탈퇴 이유[\s\S]*\(선택\)/);
  assert.match(html,/서비스를 자주 사용하지 않아요/);
  assert.match(html,/개인정보가 걱정돼요/);
  assert.doesNotMatch(html,/data-account-delete-reauth|accountDeletionProviderToken|account-deletion-reauth/);
  assert.match(html,/confirmation:"DELETE",reason:reason/);
  assert.match(html,/accountDeletionSubmitting/);
  assert.match(html,/scope:"local"/);
});
