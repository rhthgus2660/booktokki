"use strict";
var assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
var root=path.join(__dirname,"../..");
var name=fs.readdirSync(path.join(root,"supabase/migrations")).find(function(file){return /_p9a_exchange_reading_phase1\.sql$/.test(file);});
assert.ok(name,"P9-A migration must exist");
var sql=fs.readFileSync(path.join(root,"supabase/migrations",name),"utf8");

["exchange_reading_rooms","exchange_reading_members","exchange_reading_member_books","exchange_reading_messages","exchange_reading_note_shares","exchange_reading_report_evidence","exchange_reading_read_cursors","exchange_reading_report_receipts","exchange_reading_invite_blocks","exchange_reading_invitation_book_additions"].forEach(function(table){
  assert.match(sql,new RegExp("create table public\\."+table));
  assert.match(sql,new RegExp("alter table public\\."+table+" enable row level security"));
  assert.match(sql,new RegExp("revoke all on table public\\."+table+" from public,anon,authenticated,service_role"));
});
["create_exchange_reading_room","invite_exchange_reading_friends","accept_exchange_reading_invitation","decline_exchange_reading_invitation","decline_and_block_exchange_reading_inviter","list_exchange_reading_invite_blocks","unblock_exchange_reading_inviter","add_exchange_reading_book_from_invitation","leave_exchange_reading_room"].forEach(function(rpc){
  assert.match(sql,new RegExp("create function public\\."+rpc));
  assert.match(sql,new RegExp("grant execute on function public\\."+rpc));
});
assert.match(sql,/status text not null check \(status in \('invited','active','declined','left','blocked'\)\)/);
assert.match(sql,/existing_count\+cardinality\(invited_users\)>4/);
assert.match(sql,/p9a_assert_no_exchange_blocks/);
assert.match(sql,/p9a_user_block_room_exit/);
assert.match(sql,/left_reason='blocked'/);
assert.match(sql,/update public\.exchange_reading_note_shares set revoked_at=coalesce/);
assert.match(sql,/cardinality\(active_users\)<2/);
assert.match(sql,/foreign key \(book_id,user_id\)[\s\S]*references public\.books\(id,user_id\)/);
assert.match(sql,/foreign key \(note_id,owner_user_id\)[\s\S]*references public\.book_notes\(id,user_id\)/);
assert.match(sql,/evidence_kind in \('group_message','shared_book_note'\)/);
assert.match(sql,/sender_id uuid references auth\.users\(id\) on delete set null/);
assert.match(sql,/sender_deleted_at timestamptz/);
assert.match(sql,/create trigger p9a_prepare_account_delete/);
assert.match(sql,/set sender_display_name='탈퇴한 사용자',sender_deleted_at=statement_timestamp\(\)/);
assert.match(sql,/create function public\.delete_resolved_exchange_reading_report_evidence/);
assert.match(sql,/delete from public\.exchange_reading_report_evidence evidence/);
assert.match(sql,/evidence_hold_released_at is null/);
assert.match(sql,/work_isbn13 text/);
assert.match(sql,/work_total_pages integer not null check\(work_total_pages>0\)/);
assert.match(sql,/Friend invitation unavailable/);
assert.match(sql,/p9a_normalize_work_text\(source_book\.title\)=room\.work_title_key[\s\S]*p9a_normalize_work_text\(source_book\.author\)=room\.work_author_key/);
assert.match(sql,/unique\(blocker_id,blocked_inviter_id\)/);
assert.match(sql,/unique\(user_id,client_id\)/);
var invitationBookFunction=sql.match(/create function public\.add_exchange_reading_book_from_invitation[\s\S]*?\n\$\$;/i);
assert.ok(invitationBookFunction,"invitation book RPC body is present");
assert.doesNotMatch(invitationBookFunction[0],/insert into public\.reading_logs/i);
assert.doesNotMatch(sql,/grant (?:select|insert|update|delete) on table public\.exchange_reading_\w+ to (?:anon|authenticated)/i);
assert.doesNotMatch(sql,/alter table public\.(?:friend_messages|conversation_read_cursors)/i);

if(process.env.BOOKTOKKI_PGLITE_MODULE){
  var child=require("node:child_process").spawnSync(process.execPath,[path.join(__dirname,"p9a-exchange-reading-phase1.runtime.js")],{stdio:"inherit",env:process.env});
  assert.equal(child.status,0,"P9-A runtime suite must pass");
}
console.log("PASS P9-A exchange-reading Phase 1 contract tests");
