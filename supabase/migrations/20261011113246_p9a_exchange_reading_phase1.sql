begin;

set local lock_timeout = '5s';

/*
 * P9-A Phase 1: private 2-4 person exchange-reading rooms.
 *
 * Personal books, reading_logs, and book_notes remain the single source of
 * truth. Group tables are RPC-only and do not weaken the owner-only policies
 * on those personal tables. Message/share write RPCs intentionally arrive in
 * later phases; the locked tables below reserve their secure FK boundary.
 */

alter table public.book_notes
  add constraint book_notes_id_user_unique unique (id, user_id);

/* Reports survive either party's account deletion; browser access remains denied. */
alter table public.social_reports
  drop constraint social_reports_reporter_id_fkey,
  drop constraint social_reports_reported_user_id_fkey,
  alter column reporter_id drop not null,
  alter column reported_user_id drop not null,
  add column reporter_deleted_at timestamptz,
  add column reported_deleted_at timestamptz,
  add column evidence_hold_reason text,
  add column evidence_hold_approved_by text,
  add column evidence_hold_started_at timestamptz,
  add column evidence_hold_review_at timestamptz,
  add column evidence_hold_release_condition text,
  add column evidence_hold_released_at timestamptz,
  add constraint social_reports_reporter_id_fkey foreign key (reporter_id) references auth.users(id) on delete set null,
  add constraint social_reports_reported_user_id_fkey foreign key (reported_user_id) references auth.users(id) on delete set null;

alter table public.social_reports
  add constraint social_reports_evidence_hold_check check (
    (evidence_hold_reason is null and evidence_hold_approved_by is null
      and evidence_hold_started_at is null and evidence_hold_review_at is null
      and evidence_hold_release_condition is null and evidence_hold_released_at is null)
    or
    (char_length(btrim(evidence_hold_reason)) between 1 and 500
      and char_length(btrim(evidence_hold_approved_by)) between 1 and 120
      and evidence_hold_started_at is not null
      and evidence_hold_review_at is not null
      and evidence_hold_review_at>evidence_hold_started_at
      and char_length(btrim(evidence_hold_release_condition)) between 1 and 500)
  );

alter table public.conversation_report_receipts
  drop constraint conversation_report_receipts_reporter_id_fkey,
  alter column reporter_id drop not null,
  add constraint conversation_report_receipts_reporter_id_fkey foreign key (reporter_id) references auth.users(id) on delete set null;

create table public.exchange_reading_rooms (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references auth.users(id) on delete set null,
  client_id uuid not null,
  work_title text not null,
  work_author text not null,
  work_title_key text not null,
  work_author_key text not null,
  work_isbn13 text,
  work_total_pages integer not null check(work_total_pages>0),
  status text not null default 'active' check (status in ('active','ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint exchange_reading_rooms_title_check check (
    char_length(btrim(work_title)) between 1 and 200 and work_title !~ '[[:cntrl:]]'
  ),
  constraint exchange_reading_rooms_author_check check (
    char_length(btrim(work_author)) between 1 and 160 and work_author !~ '[[:cntrl:]]'
  ),
  constraint exchange_reading_rooms_end_check check (
    (status='active' and ended_at is null) or (status='ended' and ended_at is not null)
  ),
  unique(creator_id,client_id)
);

create table public.exchange_reading_members (
  room_id uuid not null references public.exchange_reading_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invited_by uuid references auth.users(id) on delete set null,
  display_name_snapshot text not null,
  status text not null check (status in ('invited','active','declined','left','blocked')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  progress_consent_at timestamptz,
  left_at timestamptz,
  left_reason text check (left_reason is null or left_reason in ('declined','voluntary','blocked','account_deleted')),
  primary key (room_id,user_id),
  constraint exchange_reading_members_name_check check (
    char_length(btrim(display_name_snapshot)) between 1 and 20
    and display_name_snapshot !~ '[[:cntrl:]]'
  ),
  constraint exchange_reading_members_state_check check (
    (status='invited' and joined_at is null and progress_consent_at is null and left_at is null and left_reason is null)
    or (status='active' and joined_at is not null and progress_consent_at is not null and left_at is null and left_reason is null)
    or (status='declined' and joined_at is null and left_at is not null and left_reason='declined')
    or (status='left' and joined_at is not null and left_at is not null and left_reason='voluntary')
    or (status='blocked' and joined_at is not null and left_at is not null and left_reason='blocked')
  )
);

create index exchange_reading_members_user_status_idx
  on public.exchange_reading_members(user_id,status,invited_at desc);
create index exchange_reading_members_room_status_idx
  on public.exchange_reading_members(room_id,status,joined_at);

create table public.exchange_reading_member_books (
  room_id uuid not null,
  user_id uuid not null,
  book_id uuid not null,
  isbn13 text,
  total_pages integer not null check (total_pages > 0),
  linked_at timestamptz not null default now(),
  primary key (room_id,user_id),
  foreign key (room_id,user_id)
    references public.exchange_reading_members(room_id,user_id) on delete cascade,
  foreign key (book_id,user_id)
    references public.books(id,user_id) on delete cascade
);

create index exchange_reading_member_books_book_idx
  on public.exchange_reading_member_books(book_id,user_id);

/* Idempotency ledger for participation-only progress baselines. */
create table public.exchange_reading_progress_baselines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null,
  book_id uuid not null,
  client_id uuid not null,
  requested_page integer not null check(requested_page>=0),
  applied_revision bigint not null,
  created_at timestamptz not null default now(),
  unique(user_id,client_id),
  foreign key(room_id,user_id) references public.exchange_reading_members(room_id,user_id) on delete cascade,
  foreign key(book_id,user_id) references public.books(id,user_id) on delete cascade
);

/* Exchange-invite-only blocks do not affect friendship, DM, or Presence. */
create table public.exchange_reading_invite_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_inviter_id uuid not null references auth.users(id) on delete cascade,
  display_name_snapshot text not null,
  created_at timestamptz not null default now(),
  unique(blocker_id,blocked_inviter_id),
  check(blocker_id<>blocked_inviter_id),
  check(char_length(btrim(display_name_snapshot)) between 1 and 20)
);

/* Idempotency and provenance for books created from a valid invitation. */
create table public.exchange_reading_invitation_book_additions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null,
  book_id uuid not null,
  client_id uuid not null,
  created_book boolean not null,
  created_at timestamptz not null default now(),
  unique(user_id,client_id),
  foreign key(room_id,user_id) references public.exchange_reading_members(room_id,user_id) on delete cascade,
  foreign key(book_id,user_id) references public.books(id,user_id) on delete cascade
);

/* Phase 2 storage boundary. No client role can read or write it directly. */
create table public.exchange_reading_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.exchange_reading_rooms(id) on delete restrict,
  sender_id uuid references auth.users(id) on delete set null,
  sender_display_name text not null,
  sender_deleted_at timestamptz,
  client_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  unique (sender_id,client_id),
  constraint exchange_reading_messages_body_check check (
    char_length(body) between 1 and 1000 and body=btrim(body)
    and body !~ '[[:cntrl:]]'
    and char_length(translate(body,' '||chr(160)||chr(12288)||chr(8203)||chr(8204)||chr(8205)||chr(8288)||chr(65279),''))>0
  )
);

create index exchange_reading_messages_room_created_idx
  on public.exchange_reading_messages(room_id,created_at desc,id desc);

/* Phase 3 share boundary. The private note body is never copied here. */
create table public.exchange_reading_note_shares (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  owner_user_id uuid not null,
  note_id uuid not null,
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (room_id,owner_user_id)
    references public.exchange_reading_members(room_id,user_id),
  foreign key (note_id,owner_user_id)
    references public.book_notes(id,user_id) on delete cascade
);

create unique index exchange_reading_note_shares_active_unique
  on public.exchange_reading_note_shares(room_id,note_id) where revoked_at is null;

create index exchange_reading_note_shares_owner_idx
  on public.exchange_reading_note_shares(owner_user_id,shared_at desc);

/* Immutable report snapshot. Source rows may later be deleted or unshared. */
create table public.exchange_reading_report_evidence (
  report_id uuid primary key references public.social_reports(id) on delete cascade,
  room_id uuid not null references public.exchange_reading_rooms(id) on delete restrict,
  evidence_kind text not null check (evidence_kind in ('group_message','shared_book_note')),
  source_id uuid not null,
  content_snapshot text not null,
  content_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint exchange_reading_report_evidence_content_check check (
    char_length(content_snapshot) between 1 and 4000
  )
);

create index exchange_reading_report_evidence_created_idx
  on public.exchange_reading_report_evidence(created_at desc);

create table public.exchange_reading_read_cursors (
  room_id uuid not null,
  user_id uuid not null,
  last_read_message_id uuid references public.exchange_reading_messages(id) on delete set null,
  last_read_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (room_id,user_id),
  foreign key (room_id,user_id)
    references public.exchange_reading_members(room_id,user_id) on delete cascade
);

create table public.exchange_reading_report_receipts (
  report_id uuid primary key references public.social_reports(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  message_id uuid not null references public.exchange_reading_messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (reporter_id,message_id)
);

create table public.exchange_reading_note_report_receipts (
  report_id uuid primary key references public.social_reports(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  share_id uuid not null references public.exchange_reading_note_shares(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (reporter_id,share_id)
);

/* A manual same-work confirmation never changes edition visibility. */
create table public.exchange_reading_work_confirmations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.exchange_reading_rooms(id) on delete cascade,
  confirmer_user_id uuid not null references auth.users(id) on delete cascade,
  linked_book_id uuid not null,
  title_snapshot text not null,
  author_snapshot text not null,
  confirmed_at timestamptz not null default now()
);

alter table public.exchange_reading_rooms enable row level security;
alter table public.exchange_reading_members enable row level security;
alter table public.exchange_reading_member_books enable row level security;
alter table public.exchange_reading_messages enable row level security;
alter table public.exchange_reading_note_shares enable row level security;
alter table public.exchange_reading_report_evidence enable row level security;
alter table public.exchange_reading_read_cursors enable row level security;
alter table public.exchange_reading_report_receipts enable row level security;
alter table public.exchange_reading_note_report_receipts enable row level security;
alter table public.exchange_reading_work_confirmations enable row level security;
alter table public.exchange_reading_progress_baselines enable row level security;
alter table public.exchange_reading_invite_blocks enable row level security;
alter table public.exchange_reading_invitation_book_additions enable row level security;

revoke all on table public.exchange_reading_rooms from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_members from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_member_books from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_messages from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_note_shares from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_report_evidence from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_read_cursors from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_report_receipts from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_note_report_receipts from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_work_confirmations from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_progress_baselines from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_invite_blocks from public,anon,authenticated,service_role;
revoke all on table public.exchange_reading_invitation_book_additions from public,anon,authenticated,service_role;
grant select on table public.exchange_reading_report_evidence to service_role;
grant select on table public.exchange_reading_report_receipts to service_role;
grant select on table public.exchange_reading_note_report_receipts to service_role;
grant select on table public.exchange_reading_work_confirmations to service_role;

create function public.p9a_normalize_work_text(p_value text)
returns text language sql immutable security invoker set search_path=''
as $$
  select lower(regexp_replace(btrim(coalesce(p_value,'')),'[[:space:]]+',' ','g'))
$$;

create function public.p9a_lock_exchange_users(p_user_ids uuid[])
returns void language plpgsql security definer set search_path='' as $$
declare locked_user uuid;
begin
  for locked_user in
    select distinct candidate from unnest(coalesce(p_user_ids,array[]::uuid[])) candidate order by candidate
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(locked_user::text,0));
  end loop;
end $$;

create function public.p9a_assert_no_exchange_blocks(p_user_ids uuid[])
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if exists (
    select 1 from public.user_blocks blocked
    where blocked.blocker_id=any(p_user_ids) and blocked.blocked_id=any(p_user_ids)
  ) then
    raise exception using errcode='42501',message='Exchange reading room unavailable';
  end if;
end $$;

create function public.p9a_assert_exchange_interaction_allowed(p_room_id uuid,p_user_id uuid)
returns void language plpgsql stable security definer set search_path='' as $$
declare active_users uuid[];
begin
  select array_agg(member.user_id order by member.user_id) into active_users
  from public.exchange_reading_members member
  join public.exchange_reading_rooms room on room.id=member.room_id and room.status='active'
  where member.room_id=p_room_id and member.status='active';
  if active_users is null or cardinality(active_users)<2 or not (p_user_id=any(active_users)) then
    raise exception using errcode='42501',message='Exchange reading interaction unavailable';
  end if;
  perform public.p9a_assert_no_exchange_blocks(active_users);
end $$;

create function public.p9a_guard_exchange_content_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='exchange_reading_messages' then
    perform public.p9a_assert_exchange_interaction_allowed(new.room_id,new.sender_id);
  else
    perform public.p9a_assert_exchange_interaction_allowed(new.room_id,new.owner_user_id);
  end if;
  return new;
end $$;

create trigger exchange_reading_messages_guard
before insert on public.exchange_reading_messages
for each row execute function public.p9a_guard_exchange_content_write();

create trigger exchange_reading_note_shares_guard
before insert on public.exchange_reading_note_shares
for each row execute function public.p9a_guard_exchange_content_write();

/* Runs inside the same PostgreSQL transaction as the GoTrue user DELETE. */
create function public.p9a_prepare_account_delete()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.exchange_reading_messages
    set sender_display_name='탈퇴한 사용자',sender_deleted_at=statement_timestamp()
    where sender_id=old.id;
  update public.social_reports
    set reporter_deleted_at=coalesce(reporter_deleted_at,statement_timestamp())
    where reporter_id=old.id;
  update public.social_reports
    set reported_deleted_at=coalesce(reported_deleted_at,statement_timestamp())
    where reported_user_id=old.id;
  return old;
end $$;

create trigger p9a_prepare_account_delete
before delete on auth.users
for each row execute function public.p9a_prepare_account_delete();

/* Baselines are participation setup, not reading activity. */
create or replace function public.booktokki_queue_completion_reaction()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if current_setting('booktokki.progress_write_kind',true)='baseline' then return new; end if;
  if new.status='done' and old.status is distinct from 'done' then
    insert into public.p6_reaction_candidates(user_id,book_id,reaction_kind,source_key,source_occurred_at,priority)
    values(new.user_id,new.id,'completion','completion:book:'||new.id::text||':revision:'||new.revision::text,coalesce(new.completed_at,new.updated_at),4)
    on conflict(user_id,source_key) do nothing;
  end if;
  return new;
end $$;

create function public.set_exchange_reading_progress_baseline(
  p_room_id uuid,p_book_id uuid,p_expected_revision bigint,p_client_id uuid,
  p_current_page integer,p_progress_consent boolean
)
returns table(book_id uuid,revision bigint,current_page integer,status text,applied boolean)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); source_book public.books%rowtype; prior public.exchange_reading_progress_baselines%rowtype; member_status text; room public.exchange_reading_rooms%rowtype;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_room_id is null or p_book_id is null or p_expected_revision is null or p_client_id is null
     or p_current_page is null or not coalesce(p_progress_consent,false) then
    raise exception using errcode='23514',message='Progress consent and baseline inputs are required'; end if;
  perform public.p9a_lock_exchange_users(array[uid]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  select m.status into member_status from public.exchange_reading_members m join public.exchange_reading_rooms r on r.id=m.room_id and r.status='active'
    where m.room_id=p_room_id and m.user_id=uid and m.status in('active','invited');
  if not found then
    raise exception using errcode='42501',message='Exchange reading participation unavailable'; end if;
  select * into room from public.exchange_reading_rooms r where r.id=p_room_id and r.status='active';
  select * into prior from public.exchange_reading_progress_baselines where user_id=uid and client_id=p_client_id;
  if found then
    if prior.room_id<>p_room_id or prior.book_id<>p_book_id or prior.requested_page<>p_current_page then
      raise exception using errcode='23505',message='Baseline client_id already belongs to another operation'; end if;
    return query select b.id,b.revision,b.current_page,b.status,false from public.books b where b.id=p_book_id and b.user_id=uid;
    return;
  end if;
  select * into source_book from public.books where id=p_book_id and user_id=uid for update;
  if not found then raise exception using errcode='42501',message='Book unavailable'; end if;
  if member_status='active' and not exists(select 1 from public.exchange_reading_member_books mb where mb.room_id=p_room_id and mb.user_id=uid and mb.book_id=p_book_id) then
    raise exception using errcode='42501',message='Linked exchange book required'; end if;
  if member_status='invited' and not (
      (room.work_isbn13~'^[0-9]{13}$' and source_book.isbn13=room.work_isbn13 and source_book.total_pages=room.work_total_pages)
      or (public.p9a_normalize_work_text(source_book.title)=room.work_title_key and public.p9a_normalize_work_text(source_book.author)=room.work_author_key)
    )
    and not exists(select 1 from public.exchange_reading_work_confirmations c where c.room_id=p_room_id and c.confirmer_user_id=uid and c.linked_book_id=p_book_id) then
    raise exception using errcode='42501',message='Confirmed exchange book required'; end if;
  if p_current_page<0 or p_current_page>source_book.total_pages then raise exception using errcode='23514',message='Invalid current page'; end if;
  if source_book.revision<>p_expected_revision then raise sqlstate 'PT409' using message='Book revision conflict'; end if;
  perform set_config('booktokki.progress_write_kind','baseline',true);
  update public.books b set current_page=p_current_page,
    status=case when p_current_page=0 then 'toread' when p_current_page=b.total_pages then 'done' else 'reading' end,
    completed_at=case when p_current_page=b.total_pages then b.completed_at else null end,
    day_start_page=case when b.last_page_log_date=current_date then p_current_page else b.day_start_page end
  where b.id=p_book_id and b.user_id=uid and b.revision=p_expected_revision
  returning b.* into source_book;
  if not found then raise sqlstate 'PT409' using message='Book revision conflict'; end if;
  insert into public.exchange_reading_progress_baselines(user_id,room_id,book_id,client_id,requested_page,applied_revision)
  values(uid,p_room_id,p_book_id,p_client_id,p_current_page,source_book.revision);
  return query select source_book.id,source_book.revision,source_book.current_page,source_book.status,true;
end $$;

create function public.add_exchange_reading_book_from_invitation(p_room_id uuid,p_client_id uuid)
returns table(
  id uuid,user_id uuid,client_id text,title text,author text,total_pages integer,current_page integer,
  status text,isbn13 text,revision bigint,created_at timestamptz,updated_at timestamptz,created_book boolean
) language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); room public.exchange_reading_rooms%rowtype;
  prior public.exchange_reading_invitation_book_additions%rowtype; selected public.books%rowtype; did_create boolean:=false;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_room_id is null or p_client_id is null then raise exception using errcode='22004',message='Invitation book request is incomplete'; end if;
  perform public.p9a_lock_exchange_users(array[uid]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  select * into room from public.exchange_reading_rooms r where r.id=p_room_id and r.status='active';
  if not found or not exists(select 1 from public.exchange_reading_members m
    where m.room_id=p_room_id and m.user_id=uid and m.status='invited') then
    raise exception using errcode='42501',message='Exchange reading invitation unavailable';
  end if;
  if room.work_total_pages is null or room.work_total_pages<1 or char_length(btrim(room.work_title))<1 then
    raise exception using errcode='23514',message='Invitation book metadata is unavailable';
  end if;
  select * into prior from public.exchange_reading_invitation_book_additions a where a.user_id=uid and a.client_id=p_client_id;
  if found then
    if prior.room_id<>p_room_id then raise exception using errcode='23505',message='Invitation book client_id already belongs to another operation'; end if;
    select * into selected from public.books b where b.id=prior.book_id and b.user_id=uid;
    if not found then raise exception using errcode='42501',message='Invitation book unavailable'; end if;
    return query select selected.id,selected.user_id,selected.client_id,selected.title,selected.author,selected.total_pages,
      selected.current_page,selected.status,selected.isbn13,selected.revision,selected.created_at,selected.updated_at,prior.created_book;
    return;
  end if;
  select * into selected from public.books b where b.user_id=uid and (
    (room.work_isbn13~'^[0-9]{13}$' and b.isbn13=room.work_isbn13 and b.total_pages=room.work_total_pages)
    or (not (room.work_isbn13~'^[0-9]{13}$') and public.p9a_normalize_work_text(b.title)=room.work_title_key
      and public.p9a_normalize_work_text(b.author)=room.work_author_key and b.total_pages=room.work_total_pages)
  ) order by b.created_at limit 1;
  if not found then
    insert into public.books(user_id,client_id,title,author,total_pages,current_page,status,isbn13,created_at,updated_at)
    values(uid,p_client_id::text,room.work_title,room.work_author,room.work_total_pages,0,'toread',
      case when room.work_isbn13~'^[0-9]{13}$' then room.work_isbn13 else null end,statement_timestamp(),statement_timestamp())
    returning * into selected;
    did_create:=true;
  end if;
  insert into public.exchange_reading_invitation_book_additions(user_id,room_id,book_id,client_id,created_book)
  values(uid,p_room_id,selected.id,p_client_id,did_create);
  return query select selected.id,selected.user_id,selected.client_id,selected.title,selected.author,selected.total_pages,
    selected.current_page,selected.status,selected.isbn13,selected.revision,selected.created_at,selected.updated_at,did_create;
end $$;

create function public.create_exchange_reading_room(
  p_book_id uuid,
  p_invited_connection_ids uuid[],
  p_expected_revision bigint,p_baseline_client_id uuid,p_current_page integer,p_progress_consent boolean
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid(); source_book public.books%rowtype; room_id uuid:=gen_random_uuid();
  existing_room_id uuid; invited_users uuid[]; participants uuid[]; invited_count integer;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_book_id is null or p_invited_connection_ids is null or not coalesce(p_progress_consent,false)
     or cardinality(p_invited_connection_ids)<1 or cardinality(p_invited_connection_ids)>3 then
    raise exception using errcode='23514',message='Invite one to three friends';
  end if;
  if cardinality(p_invited_connection_ids)<>(select count(distinct item)::int from unnest(p_invited_connection_ids) item) then
    raise exception using errcode='23514',message='Duplicate invitations are not allowed';
  end if;
  select r.id into existing_room_id from public.exchange_reading_rooms r where r.creator_id=uid and r.client_id=p_baseline_client_id;
  if found then return existing_room_id; end if;
  select * into source_book from public.books where id=p_book_id and user_id=uid;
  if not found then raise exception using errcode='42501',message='Book unavailable'; end if;

  select array_agg(link.friend_user_id order by link.friend_user_id),count(*)::int
    into invited_users,invited_count
  from unnest(p_invited_connection_ids) requested(connection_id)
  join public.friend_links link on link.connection_id=requested.connection_id and link.user_id=uid;
  if invited_count<>cardinality(p_invited_connection_ids) then
    raise exception using errcode='42501',message='Friend invitation unavailable';
  end if;
  participants:=array_append(invited_users,uid);
  perform public.p9a_lock_exchange_users(participants);
  if exists(select 1 from public.exchange_reading_invite_blocks blocked
    where blocked.blocker_id=any(invited_users) and blocked.blocked_inviter_id=uid) then
    raise exception using errcode='42501',message='Friend invitation unavailable';
  end if;

  if (select count(*) from public.friend_links link
      where link.user_id=uid and link.friend_user_id=any(invited_users)
        and link.connection_id=any(p_invited_connection_ids))<>cardinality(invited_users) then
    raise exception using errcode='42501',message='Friend invitation unavailable';
  end if;
  perform public.p9a_assert_no_exchange_blocks(participants);
  if (select count(*) from public.friend_profiles profile where profile.user_id=any(participants))<>cardinality(participants) then
    raise exception using errcode='23514',message='Every member needs a social profile';
  end if;

  insert into public.exchange_reading_rooms(
    id,creator_id,client_id,work_title,work_author,work_title_key,work_author_key,work_isbn13,work_total_pages
  ) values(
    room_id,uid,p_baseline_client_id,source_book.title,source_book.author,
    public.p9a_normalize_work_text(source_book.title),public.p9a_normalize_work_text(source_book.author),
    case when source_book.isbn13~'^[0-9]{13}$' then source_book.isbn13 else null end,source_book.total_pages
  );
  insert into public.exchange_reading_members(
    room_id,user_id,invited_by,display_name_snapshot,status,invited_at,joined_at,progress_consent_at
  ) select room_id,uid,null,profile.display_name,'active',statement_timestamp(),statement_timestamp(),statement_timestamp()
    from public.friend_profiles profile where profile.user_id=uid;
  insert into public.exchange_reading_member_books(room_id,user_id,book_id,isbn13,total_pages)
    values(room_id,uid,source_book.id,source_book.isbn13,source_book.total_pages);
  insert into public.exchange_reading_members(room_id,user_id,invited_by,display_name_snapshot,status)
    select room_id,profile.user_id,uid,profile.display_name,'invited'
    from public.friend_profiles profile where profile.user_id=any(invited_users);
  perform public.set_exchange_reading_progress_baseline(room_id,p_book_id,p_expected_revision,p_baseline_client_id,p_current_page,p_progress_consent);
  return room_id;
end $$;

create function public.invite_exchange_reading_friends(
  p_room_id uuid,
  p_invited_connection_ids uuid[]
)
returns integer language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); invited_users uuid[]; lock_users uuid[]; invited_count integer; existing_count integer;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_room_id is null or p_invited_connection_ids is null
     or cardinality(p_invited_connection_ids)<1 or cardinality(p_invited_connection_ids)>3 then
    raise exception using errcode='23514',message='Invite one to three friends';
  end if;
  if cardinality(p_invited_connection_ids)<>(select count(distinct item)::int from unnest(p_invited_connection_ids) item) then
    raise exception using errcode='23514',message='Duplicate invitations are not allowed';
  end if;
  select array_agg(link.friend_user_id order by link.friend_user_id),count(*)::int
    into invited_users,invited_count
  from unnest(p_invited_connection_ids) requested(connection_id)
  join public.friend_links link on link.connection_id=requested.connection_id and link.user_id=uid;
  if invited_count<>cardinality(p_invited_connection_ids) then
    raise exception using errcode='42501',message='Friend invitation unavailable';
  end if;
  select array_agg(distinct member.user_id order by member.user_id) into lock_users
  from public.exchange_reading_members member
  where member.room_id=p_room_id and member.status in('active','invited');
  lock_users:=coalesce(lock_users,array[]::uuid[])||invited_users||array[uid];
  perform public.p9a_lock_exchange_users(lock_users);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  if exists(select 1 from public.exchange_reading_invite_blocks blocked
    where blocked.blocker_id=any(invited_users) and blocked.blocked_inviter_id=uid) then
    raise exception using errcode='42501',message='Friend invitation unavailable';
  end if;

  if not exists(select 1 from public.exchange_reading_rooms where id=p_room_id and status='active')
     or not exists(select 1 from public.exchange_reading_members where room_id=p_room_id and user_id=uid and status='active') then
    raise exception using errcode='42501',message='Exchange reading room unavailable';
  end if;
  if (select count(*) from public.friend_links link
      where link.user_id=uid and link.friend_user_id=any(invited_users)
        and link.connection_id=any(p_invited_connection_ids))<>cardinality(invited_users) then
    raise exception using errcode='42501',message='Friend invitation unavailable';
  end if;
  if exists(select 1 from public.exchange_reading_members
    where room_id=p_room_id and user_id=any(invited_users) and status in('active','invited','blocked')) then
    raise exception using errcode='PT409',message='A selected user is not eligible for a new invitation';
  end if;
  select count(*)::int into existing_count from public.exchange_reading_members
    where room_id=p_room_id and status in('active','invited');
  if existing_count+cardinality(invited_users)>4 then
    raise exception using errcode='23514',message='Exchange reading rooms support up to four members';
  end if;
  lock_users:=(select array_agg(distinct candidate order by candidate)
    from unnest(lock_users) candidate);
  perform public.p9a_assert_no_exchange_blocks(lock_users);
  if (select count(*) from public.friend_profiles profile where profile.user_id=any(invited_users))<>cardinality(invited_users) then
    raise exception using errcode='23514',message='Every member needs a social profile';
  end if;
  delete from public.exchange_reading_member_books mapped
    where mapped.room_id=p_room_id and mapped.user_id=any(invited_users)
      and exists(select 1 from public.exchange_reading_members member
        where member.room_id=mapped.room_id and member.user_id=mapped.user_id
          and member.status in('declined','left'));
  insert into public.exchange_reading_members(room_id,user_id,invited_by,display_name_snapshot,status)
    select p_room_id,profile.user_id,uid,profile.display_name,'invited'
    from public.friend_profiles profile where profile.user_id=any(invited_users)
  on conflict(room_id,user_id) do update set
    invited_by=excluded.invited_by,display_name_snapshot=excluded.display_name_snapshot,
    status='invited',invited_at=statement_timestamp(),joined_at=null,progress_consent_at=null,left_at=null,left_reason=null
  where exchange_reading_members.status in('declined','left');
  return cardinality(invited_users);
end $$;

create function public.accept_exchange_reading_invitation(
  p_room_id uuid,p_book_id uuid,p_confirm_same_work boolean,
  p_expected_revision bigint,p_baseline_client_id uuid,p_current_page integer,p_progress_consent boolean
)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); room public.exchange_reading_rooms%rowtype; source_book public.books%rowtype;
  lock_users uuid[]; active_users uuid[]; active_count integer;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if not coalesce(p_progress_consent,false) then raise exception using errcode='23514',message='Progress sharing consent is required'; end if;
  select array_agg(member.user_id order by member.user_id) into lock_users
  from public.exchange_reading_members member
  where member.room_id=p_room_id and member.status in('active','invited');
  lock_users:=coalesce(lock_users,array[]::uuid[])||array[uid];
  perform public.p9a_lock_exchange_users(lock_users);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  select * into room from public.exchange_reading_rooms where id=p_room_id and status='active';
  if not found then
    raise exception using errcode='42501',message='Exchange reading invitation unavailable';
  end if;
  if exists(
    select 1
    from public.exchange_reading_members member
    join public.exchange_reading_member_books linked
      on linked.room_id=member.room_id and linked.user_id=member.user_id
    join public.exchange_reading_progress_baselines baseline
      on baseline.room_id=member.room_id and baseline.user_id=member.user_id and baseline.book_id=linked.book_id
    where member.room_id=p_room_id and member.user_id=uid and member.status='active'
      and member.progress_consent_at is not null and linked.book_id=p_book_id
      and baseline.client_id=p_baseline_client_id and baseline.requested_page=p_current_page
  ) then
    return true;
  end if;
  if not exists(
    select 1 from public.exchange_reading_members where room_id=p_room_id and user_id=uid and status='invited'
  ) then raise exception using errcode='42501',message='Exchange reading invitation unavailable'; end if;
  select * into source_book from public.books where id=p_book_id and user_id=uid;
  if not found then raise exception using errcode='42501',message='Book unavailable'; end if;
  if not (
       (room.work_isbn13~'^[0-9]{13}$' and source_book.isbn13=room.work_isbn13 and source_book.total_pages=room.work_total_pages)
       or (public.p9a_normalize_work_text(source_book.title)=room.work_title_key
         and public.p9a_normalize_work_text(source_book.author)=room.work_author_key)
     ) and not coalesce(p_confirm_same_work,false) then
    raise exception using errcode='23514',message='The selected book is a different work';
  end if;
  if not (
       (room.work_isbn13~'^[0-9]{13}$' and source_book.isbn13=room.work_isbn13 and source_book.total_pages=room.work_total_pages)
       or (public.p9a_normalize_work_text(source_book.title)=room.work_title_key
         and public.p9a_normalize_work_text(source_book.author)=room.work_author_key)
     ) and coalesce(p_confirm_same_work,false) then
    insert into public.exchange_reading_work_confirmations(
      room_id,confirmer_user_id,linked_book_id,title_snapshot,author_snapshot
    ) values(p_room_id,uid,source_book.id,source_book.title,source_book.author);
  end if;
  select array_agg(member.user_id order by member.user_id),count(*)::int into active_users,active_count
  from public.exchange_reading_members member where member.room_id=p_room_id and member.status='active';
  if active_count>=4 then raise exception using errcode='23514',message='Exchange reading room is full'; end if;
  perform public.p9a_assert_no_exchange_blocks(coalesce(active_users,array[]::uuid[])||array[uid]);
  perform public.set_exchange_reading_progress_baseline(p_room_id,p_book_id,p_expected_revision,p_baseline_client_id,p_current_page,p_progress_consent);
  update public.exchange_reading_members set status='active',joined_at=statement_timestamp(),progress_consent_at=statement_timestamp()
    where room_id=p_room_id and user_id=uid and status='invited';
  if not found then raise exception using errcode='42501',message='Exchange reading invitation unavailable'; end if;
  insert into public.exchange_reading_member_books(room_id,user_id,book_id,isbn13,total_pages)
    values(p_room_id,uid,source_book.id,source_book.isbn13,source_book.total_pages);
  return true;
end $$;

create function public.decline_exchange_reading_invitation(p_room_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); lock_users uuid[];
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select array_agg(member.user_id order by member.user_id) into lock_users
  from public.exchange_reading_members member
  where member.room_id=p_room_id and member.status in('active','invited');
  perform public.p9a_lock_exchange_users(coalesce(lock_users,array[]::uuid[])||array[uid]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  update public.exchange_reading_members
    set status='declined',left_at=statement_timestamp(),left_reason='declined'
    where room_id=p_room_id and user_id=uid and status='invited';
  return found;
end $$;

create function public.decline_and_block_exchange_reading_inviter(p_room_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); inviter uuid; inviter_name text; lock_users uuid[];
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select member.invited_by,coalesce(inviter_member.display_name_snapshot,profile.display_name)
    into inviter,inviter_name
  from public.exchange_reading_members member
  left join public.exchange_reading_members inviter_member on inviter_member.room_id=member.room_id and inviter_member.user_id=member.invited_by
  left join public.friend_profiles profile on profile.user_id=member.invited_by
  where member.room_id=p_room_id and member.user_id=uid and member.status='invited';
  if not found or inviter is null or inviter_name is null then
    raise exception using errcode='42501',message='Exchange reading invitation unavailable';
  end if;
  lock_users:=array[uid,inviter];
  perform public.p9a_lock_exchange_users(lock_users);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  if not exists(select 1 from public.exchange_reading_members member
    where member.room_id=p_room_id and member.user_id=uid and member.status='invited' and member.invited_by=inviter) then
    raise exception using errcode='42501',message='Exchange reading invitation unavailable';
  end if;
  insert into public.exchange_reading_invite_blocks(blocker_id,blocked_inviter_id,display_name_snapshot)
  values(uid,inviter,inviter_name)
  on conflict(blocker_id,blocked_inviter_id) do nothing;
  update public.exchange_reading_members set status='declined',left_at=statement_timestamp(),left_reason='declined'
    where room_id=p_room_id and user_id=uid and status='invited';
  return true;
end $$;

create function public.list_exchange_reading_invite_blocks()
returns table(block_id uuid,display_name text,blocked_at timestamptz)
language sql stable security definer set search_path='' as $$
  select blocked.id,blocked.display_name_snapshot,blocked.created_at
  from public.exchange_reading_invite_blocks blocked
  where blocked.blocker_id=auth.uid()
  order by blocked.created_at desc
$$;

create function public.unblock_exchange_reading_inviter(p_block_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); blocked_user uuid;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select blocked.blocked_inviter_id into blocked_user from public.exchange_reading_invite_blocks blocked
    where blocked.id=p_block_id and blocked.blocker_id=uid;
  if not found then raise exception using errcode='42501',message='Exchange invitation block unavailable'; end if;
  perform public.p9a_lock_exchange_users(array[uid,blocked_user]);
  delete from public.exchange_reading_invite_blocks where id=p_block_id and blocker_id=uid;
  return found;
end $$;

create function public.leave_exchange_reading_room(p_room_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); lock_users uuid[];
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select array_agg(member.user_id order by member.user_id) into lock_users
  from public.exchange_reading_members member
  where member.room_id=p_room_id and member.status in('active','invited');
  perform public.p9a_lock_exchange_users(coalesce(lock_users,array[]::uuid[])||array[uid]);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  update public.exchange_reading_members
    set status='left',left_at=statement_timestamp(),left_reason='voluntary'
    where room_id=p_room_id and user_id=uid and status='active';
  if not found then return false; end if;
  update public.exchange_reading_note_shares set revoked_at=coalesce(revoked_at,statement_timestamp())
    where room_id=p_room_id and owner_user_id=uid and revoked_at is null;
  if not exists(select 1 from public.exchange_reading_members where room_id=p_room_id and status='active') then
    update public.exchange_reading_rooms set status='ended',ended_at=statement_timestamp()
      where id=p_room_id and status='active';
  end if;
  return true;
end $$;

create function public.p9a_leave_shared_rooms_on_block()
returns trigger language plpgsql security definer set search_path='' as $$
declare shared_room uuid;
begin
  for shared_room in
    select blocker.room_id
    from public.exchange_reading_members blocker
    join public.exchange_reading_members blocked on blocked.room_id=blocker.room_id
    join public.exchange_reading_rooms room on room.id=blocker.room_id and room.status='active'
    where blocker.user_id=new.blocker_id and blocker.status='active'
      and blocked.user_id=new.blocked_id and blocked.status='active'
    order by blocker.room_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||shared_room::text,0));
    update public.exchange_reading_members
      set status='blocked',left_at=statement_timestamp(),left_reason='blocked'
      where room_id=shared_room and user_id=new.blocker_id and status='active';
    update public.exchange_reading_note_shares set revoked_at=coalesce(revoked_at,statement_timestamp())
      where room_id=shared_room and owner_user_id=new.blocker_id and revoked_at is null;
    if not exists(select 1 from public.exchange_reading_members where room_id=shared_room and status='active') then
      update public.exchange_reading_rooms set status='ended',ended_at=statement_timestamp()
        where id=shared_room and status='active';
    end if;
  end loop;
  return new;
end $$;

create trigger p9a_user_block_room_exit
after insert on public.user_blocks
for each row execute function public.p9a_leave_shared_rooms_on_block();

create function public.list_exchange_reading_rooms()
returns table(
  room_id uuid,work_title text,work_author text,member_count integer,linked_book_id uuid,
  last_message text,last_message_at timestamptz,last_message_is_mine boolean,
  unread_count bigint,can_send boolean
) language sql stable security definer set search_path='' as $$
  with mine as (
    select member.room_id from public.exchange_reading_members member
    join public.exchange_reading_rooms room on room.id=member.room_id and room.status='active'
    where member.user_id=auth.uid() and member.status='active'
  ), active_counts as (
    select member.room_id,count(*)::int member_count,array_agg(member.user_id order by member.user_id) users
    from public.exchange_reading_members member join mine on mine.room_id=member.room_id
    where member.status='active' group by member.room_id
  )
  select room.id,room.work_title,room.work_author,counts.member_count,mapped.book_id,
    latest.body,latest.created_at,(latest.sender_id=auth.uid()),
    (select count(*) from public.exchange_reading_messages message
      where message.room_id=room.id and message.sender_id<>auth.uid()
        and (cursor.last_read_at is null or (message.created_at,message.id)>(cursor.last_read_at,coalesce(cursor.last_read_message_id,'00000000-0000-0000-0000-000000000000'::uuid))))::bigint,
    counts.member_count>=2 and not exists(
      select 1 from public.user_blocks blocked
      where blocked.blocker_id=any(counts.users) and blocked.blocked_id=any(counts.users)
    )
  from mine join public.exchange_reading_rooms room on room.id=mine.room_id
  join active_counts counts on counts.room_id=room.id
  left join public.exchange_reading_member_books mapped on mapped.room_id=room.id and mapped.user_id=auth.uid()
  left join public.exchange_reading_read_cursors cursor on cursor.room_id=room.id and cursor.user_id=auth.uid()
  left join lateral(select message.body,message.created_at,message.sender_id
    from public.exchange_reading_messages message where message.room_id=room.id
    order by message.created_at desc,message.id desc limit 1) latest on true
  order by latest.created_at desc nulls last,room.created_at desc
$$;

create function public.list_exchange_reading_invitations()
returns table(room_id uuid,work_title text,work_author text,work_isbn13 text,work_total_pages integer,inviter_display_name text,invited_at timestamptz)
language sql stable security definer set search_path='' as $$
  select room.id,room.work_title,room.work_author,room.work_isbn13,room.work_total_pages,inviter.display_name_snapshot,member.invited_at
  from public.exchange_reading_members member
  join public.exchange_reading_rooms room on room.id=member.room_id and room.status='active'
  left join public.exchange_reading_members inviter
    on inviter.room_id=member.room_id and inviter.user_id=member.invited_by
  where member.user_id=auth.uid() and member.status='invited'
    and not exists(select 1 from public.exchange_reading_invite_blocks invite_block
      where invite_block.blocker_id=auth.uid() and invite_block.blocked_inviter_id=member.invited_by)
    and not exists(select 1 from public.user_blocks blocked
      where (blocked.blocker_id=auth.uid() and blocked.blocked_id=member.invited_by)
         or (blocked.blocker_id=member.invited_by and blocked.blocked_id=auth.uid()))
  order by member.invited_at desc
$$;

create function public.list_exchange_reading_invitable_friends(p_room_id uuid default null)
returns table(connection_id uuid,friend_display_name text)
language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); occupied integer;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_room_id is not null then
    if not exists(select 1 from public.exchange_reading_rooms room
      join public.exchange_reading_members member on member.room_id=room.id
      where room.id=p_room_id and room.status='active' and member.user_id=uid and member.status='active') then
      raise exception using errcode='42501',message='Exchange reading room unavailable';
    end if;
    select count(*)::int into occupied from public.exchange_reading_members
      where room_id=p_room_id and status in('active','invited');
    if occupied>=4 then return; end if;
  end if;
  return query
  select link.connection_id,profile.display_name
  from public.friend_links link
  join public.friend_profiles profile on profile.user_id=link.friend_user_id
  where link.user_id=uid
    and not exists(select 1 from public.user_blocks blocked
      where (blocked.blocker_id=uid and blocked.blocked_id=link.friend_user_id)
         or (blocked.blocker_id=link.friend_user_id and blocked.blocked_id=uid))
    and not exists(select 1 from public.exchange_reading_invite_blocks invite_block
      where invite_block.blocker_id=link.friend_user_id and invite_block.blocked_inviter_id=uid)
    and (p_room_id is null or not exists(select 1 from public.exchange_reading_members member
      where member.room_id=p_room_id and member.user_id=link.friend_user_id
        and member.status in('active','invited','blocked')))
  order by profile.display_name,link.connection_id;
end $$;

create function public.get_exchange_reading_messages(
  p_room_id uuid,p_before_created_at timestamptz default null,
  p_before_id uuid default null,p_limit integer default 50
) returns table(
  id uuid,body text,created_at timestamptz,sender_display_name text,
  sender_is_me boolean,can_send boolean
) language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); allowed boolean;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if not exists(select 1 from public.exchange_reading_members member
    join public.exchange_reading_rooms room on room.id=member.room_id and room.status='active'
    where member.room_id=p_room_id and member.user_id=uid and member.status='active') then
    raise exception using errcode='42501',message='Exchange reading room unavailable';
  end if;
  perform public.p9a_assert_no_exchange_blocks(array(select member.user_id
    from public.exchange_reading_members member where member.room_id=p_room_id and member.status='active'));
  allowed:=(select count(*)>=2 from public.exchange_reading_members member
    where member.room_id=p_room_id and member.status='active');
  return query select message.id,message.body,message.created_at,message.sender_display_name,
    message.sender_id=uid,allowed
  from public.exchange_reading_messages message where message.room_id=p_room_id
    and (p_before_created_at is null or (message.created_at,message.id)<(p_before_created_at,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  order by message.created_at desc,message.id desc limit least(greatest(coalesce(p_limit,50),1),100);
end $$;

create function public.send_exchange_reading_message(p_room_id uuid,p_client_id uuid,p_body text)
returns table(id uuid,body text,created_at timestamptz,sender_display_name text,sender_is_me boolean,can_send boolean)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); message_body text:=btrim(coalesce(p_body,'')); sender_name text; existing public.exchange_reading_messages%rowtype;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_room_id is null or p_client_id is null then raise exception using errcode='22004',message='Message request is incomplete'; end if;
  if char_length(message_body)<1 or char_length(message_body)>1000 or message_body~'[[:cntrl:]]'
    or char_length(translate(message_body,' '||chr(160)||chr(12288)||chr(8203)||chr(8204)||chr(8205)||chr(8288)||chr(65279),''))=0 then
    raise exception using errcode='23514',message='Message must be 1 to 1000 plain text characters';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-room:'||p_room_id::text,0));
  perform public.p9a_assert_exchange_interaction_allowed(p_room_id,uid);
  select * into existing from public.exchange_reading_messages message
    where message.sender_id=uid and message.client_id=p_client_id;
  if found then
    if existing.room_id<>p_room_id or existing.body<>message_body then raise exception using errcode='PT409',message='Message retry does not match'; end if;
    return query select existing.id,existing.body,existing.created_at,existing.sender_display_name,true,true; return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-rate:'||p_room_id::text||':'||uid::text,0));
  if (select count(*) from public.exchange_reading_messages message
      where message.room_id=p_room_id and message.sender_id=uid and message.created_at>statement_timestamp()-interval '1 minute')>=20 then
    raise exception using errcode='PGRST',
      message='{"code":"GROUP_RATE_LIMIT","message":"잠시 후 다시 보내 주세요.","details":null,"hint":null}',
      detail='{"status":429,"headers":{"Retry-After":"60"}}';
  end if;
  select member.display_name_snapshot into sender_name from public.exchange_reading_members member
    where member.room_id=p_room_id and member.user_id=uid and member.status='active';
  insert into public.exchange_reading_messages(room_id,sender_id,sender_display_name,client_id,body)
    values(p_room_id,uid,sender_name,p_client_id,message_body)
    returning exchange_reading_messages.* into existing;
  return query select existing.id,existing.body,existing.created_at,existing.sender_display_name,true,true;
end $$;

create function public.mark_exchange_reading_room_read(p_room_id uuid,p_through_message_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); target public.exchange_reading_messages%rowtype;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if not exists(select 1 from public.exchange_reading_members where room_id=p_room_id and user_id=uid and status='active') then
    raise exception using errcode='42501',message='Exchange reading room unavailable'; end if;
  perform public.p9a_assert_no_exchange_blocks(array(select member.user_id from public.exchange_reading_members member where member.room_id=p_room_id and member.status='active'));
  select * into target from public.exchange_reading_messages where id=p_through_message_id and room_id=p_room_id;
  if not found then raise exception using errcode='42501',message='Message unavailable'; end if;
  insert into public.exchange_reading_read_cursors(room_id,user_id,last_read_message_id,last_read_at,updated_at)
    values(p_room_id,uid,target.id,target.created_at,statement_timestamp())
  on conflict(room_id,user_id) do update set
    last_read_message_id=excluded.last_read_message_id,last_read_at=excluded.last_read_at,updated_at=excluded.updated_at
  where exchange_reading_read_cursors.last_read_at is null
     or (excluded.last_read_at,excluded.last_read_message_id)>(exchange_reading_read_cursors.last_read_at,coalesce(exchange_reading_read_cursors.last_read_message_id,'00000000-0000-0000-0000-000000000000'::uuid));
  return true;
end $$;

create function public.report_exchange_reading_message(
  p_room_id uuid,p_message_id uuid,p_category text,p_detail text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); reported public.exchange_reading_messages%rowtype; rid uuid;
  detail text:=nullif(btrim(coalesce(p_detail,'')),''); existing_category text; existing_detail text;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_category not in('spam','harassment','inappropriate_content','other') then raise exception using errcode='23514',message='Invalid report category'; end if;
  if detail is not null and (char_length(detail)>500 or detail~'[[:cntrl:]]') then raise exception using errcode='23514',message='Invalid report detail'; end if;
  if not exists(select 1 from public.exchange_reading_members where room_id=p_room_id and user_id=uid and status='active') then
    raise exception using errcode='42501',message='Report message unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_message_id::text,0));
  select * into reported from public.exchange_reading_messages
    where id=p_message_id and room_id=p_room_id and sender_id<>uid;
  if not found then raise exception using errcode='42501',message='Report message unavailable'; end if;
  select report.id,report.category,report.detail into rid,existing_category,existing_detail
    from public.exchange_reading_report_receipts receipt join public.social_reports report on report.id=receipt.report_id
    where receipt.message_id=p_message_id and receipt.reporter_id=uid;
  if found then
    if existing_category<>p_category or existing_detail is distinct from detail then raise sqlstate 'PT409' using message='Message report already submitted'; end if;
    return rid;
  end if;
  insert into public.social_reports(reporter_id,reported_user_id,category,detail,reported_display_name,reported_intro)
    values(uid,reported.sender_id,p_category,detail,reported.sender_display_name,null) returning social_reports.id into rid;
  insert into public.exchange_reading_report_evidence(report_id,room_id,evidence_kind,source_id,content_snapshot,content_created_at)
    values(rid,p_room_id,'group_message',reported.id,reported.body,reported.created_at);
  insert into public.exchange_reading_report_receipts(report_id,reporter_id,message_id) values(rid,uid,reported.id);
  return rid;
end $$;

create function public.share_exchange_reading_note(p_room_id uuid,p_note_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); result_id uuid; mapped_book uuid;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-note:'||p_room_id::text||':'||p_note_id::text,0));
  perform public.p9a_assert_exchange_interaction_allowed(p_room_id,uid);
  select book_id into mapped_book from public.exchange_reading_member_books
    where room_id=p_room_id and user_id=uid;
  if mapped_book is null or not exists(
    select 1 from public.book_notes note where note.id=p_note_id and note.user_id=uid and note.book_id=mapped_book
  ) then raise exception using errcode='42501',message='Book note unavailable'; end if;
  select share.id into result_id from public.exchange_reading_note_shares share
    where share.room_id=p_room_id and share.note_id=p_note_id and share.owner_user_id=uid and share.revoked_at is null;
  if found then return result_id; end if;
  insert into public.exchange_reading_note_shares(room_id,owner_user_id,note_id)
    values(p_room_id,uid,p_note_id) returning id into result_id;
  return result_id;
end $$;

create function public.revoke_exchange_reading_note_share(p_room_id uuid,p_share_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); target_note uuid;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if not exists(select 1 from public.exchange_reading_members where room_id=p_room_id and user_id=uid and status='active') then
    raise exception using errcode='42501',message='Exchange reading room unavailable'; end if;
  select note_id into target_note from public.exchange_reading_note_shares
    where id=p_share_id and room_id=p_room_id and owner_user_id=uid and revoked_at is null;
  if target_note is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-note:'||p_room_id::text||':'||target_note::text,0));
  update public.exchange_reading_note_shares set revoked_at=statement_timestamp()
    where id=p_share_id and room_id=p_room_id and owner_user_id=uid and revoked_at is null;
  return found;
end $$;

create function public.list_my_exchange_reading_notes(p_room_id uuid)
returns table(note_id uuid,note_client_id text,note_text text,note_page integer,note_created_at timestamptz,active_share_id uuid)
language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null or not exists(select 1 from public.exchange_reading_members where room_id=p_room_id and user_id=uid and status='active') then
    raise exception using errcode='42501',message='Exchange reading room unavailable'; end if;
  return query select note.id,note.client_id,note.text,note.page,note.created_at,share.id
    from public.exchange_reading_member_books mapped
    join public.book_notes note on note.book_id=mapped.book_id and note.user_id=uid
    left join public.exchange_reading_note_shares share on share.room_id=p_room_id and share.note_id=note.id and share.revoked_at is null
    where mapped.room_id=p_room_id and mapped.user_id=uid
    order by note.created_at desc,note.id desc;
end $$;

create function public.list_exchange_reading_shared_notes(p_room_id uuid)
returns table(
  share_id uuid,owner_display_name text,is_mine boolean,is_locked boolean,lock_reason text,
  note_text text,note_page integer,note_created_at timestamptz,shared_at timestamptz
) language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); viewer_book public.books%rowtype;
begin
  if uid is null or not exists(select 1 from public.exchange_reading_members member
    join public.exchange_reading_rooms room on room.id=member.room_id and room.status='active'
    where member.room_id=p_room_id and member.user_id=uid and member.status='active') then
    raise exception using errcode='42501',message='Exchange reading room unavailable'; end if;
  perform public.p9a_assert_no_exchange_blocks(array(select member.user_id from public.exchange_reading_members member where member.room_id=p_room_id and member.status='active'));
  select book.* into viewer_book from public.exchange_reading_member_books mapped
    join public.books book on book.id=mapped.book_id and book.user_id=uid
    where mapped.room_id=p_room_id and mapped.user_id=uid;
  return query
  select share.id,owner.display_name_snapshot,share.owner_user_id=uid,
    share.revoked_at is not null or not access.allowed,
    case when share.revoked_at is not null then 'revoked'
      when access.allowed then null
      when viewer_book.id is null then 'link_unavailable'
      when note.page is null then 'completion_required'
      when editions.same_edition then 'page_required'
      else 'completion_required' end,
    case when share.revoked_at is null and access.allowed then note.text else null end,
    case when share.revoked_at is null and access.allowed then note.page else null end,
    case when share.revoked_at is null and access.allowed then note.created_at else null end,
    share.shared_at
  from public.exchange_reading_note_shares share
  join public.exchange_reading_members owner on owner.room_id=share.room_id and owner.user_id=share.owner_user_id and owner.status='active'
  join public.book_notes note on note.id=share.note_id and note.user_id=share.owner_user_id
  join public.exchange_reading_member_books owner_map on owner_map.room_id=share.room_id and owner_map.user_id=share.owner_user_id and owner_map.book_id=note.book_id
  join public.books owner_book on owner_book.id=owner_map.book_id and owner_book.user_id=share.owner_user_id
  cross join lateral(select
    owner_book.isbn13~'^[0-9]{13}$' and viewer_book.isbn13~'^[0-9]{13}$'
      and owner_book.isbn13=viewer_book.isbn13 and owner_book.total_pages=viewer_book.total_pages as same_edition
  ) editions
  cross join lateral(select share.owner_user_id=uid or
    case when viewer_book.id is null then false
      when note.page is null then viewer_book.status='done' and viewer_book.current_page=viewer_book.total_pages
      when editions.same_edition then note.page<=viewer_book.current_page
      else viewer_book.status='done' and viewer_book.current_page=viewer_book.total_pages end as allowed
  ) access
  where share.room_id=p_room_id
  order by share.shared_at desc,share.id desc;
end $$;

create function public.get_exchange_reading_room_detail(p_room_id uuid)
returns table(
  work_title text,work_author text,member_display_name text,is_me boolean,
  current_page integer,total_pages integer,is_completed boolean,same_edition boolean
) language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); viewer_book public.books%rowtype; active_users uuid[];
begin
  if uid is null or not exists(select 1 from public.exchange_reading_members m
    join public.exchange_reading_rooms r on r.id=m.room_id and r.status='active'
    where m.room_id=p_room_id and m.user_id=uid and m.status='active' and m.progress_consent_at is not null) then
    raise exception using errcode='42501',message='Exchange reading room unavailable'; end if;
  select array_agg(m.user_id order by m.user_id) into active_users from public.exchange_reading_members m
    where m.room_id=p_room_id and m.status='active' and m.progress_consent_at is not null;
  perform public.p9a_assert_no_exchange_blocks(active_users);
  select b.* into viewer_book from public.exchange_reading_member_books mb
    join public.books b on b.id=mb.book_id and b.user_id=uid where mb.room_id=p_room_id and mb.user_id=uid;
  return query
  select r.work_title,r.work_author,m.display_name_snapshot,m.user_id=uid,b.current_page,b.total_pages,
    b.status='done' and b.current_page=b.total_pages,
    (b.isbn13~'^[0-9]{13}$' and viewer_book.isbn13~'^[0-9]{13}$' and b.isbn13=viewer_book.isbn13 and b.total_pages=viewer_book.total_pages)
  from public.exchange_reading_members m
  join public.exchange_reading_rooms r on r.id=m.room_id
  join public.exchange_reading_member_books mb on mb.room_id=m.room_id and mb.user_id=m.user_id
  join public.books b on b.id=mb.book_id and b.user_id=m.user_id
  where m.room_id=p_room_id and m.status='active' and m.progress_consent_at is not null
  order by m.joined_at,m.user_id;
end $$;

create function public.report_exchange_reading_shared_note(
  p_room_id uuid,p_share_id uuid,p_category text,p_detail text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); shared record; rid uuid; detail text:=nullif(btrim(coalesce(p_detail,'')),'');
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_category not in('spam','harassment','inappropriate_content','other') then raise exception using errcode='23514',message='Invalid report category'; end if;
  if detail is not null and (char_length(detail)>500 or detail~'[[:cntrl:]]') then raise exception using errcode='23514',message='Invalid report detail'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exchange-share-report:'||p_share_id::text||':'||uid::text,0));
  select listed.share_id,listed.note_text,listed.note_created_at,share.owner_user_id,owner.display_name_snapshot
    into shared from public.list_exchange_reading_shared_notes(p_room_id) listed
    join public.exchange_reading_note_shares share on share.id=listed.share_id
    join public.exchange_reading_members owner on owner.room_id=share.room_id and owner.user_id=share.owner_user_id
    where listed.share_id=p_share_id and not listed.is_mine and not listed.is_locked;
  if not found then raise exception using errcode='42501',message='Shared note unavailable'; end if;
  select receipt.report_id into rid from public.exchange_reading_note_report_receipts receipt
    where receipt.reporter_id=uid and receipt.share_id=p_share_id;
  if found then return rid; end if;
  insert into public.social_reports(reporter_id,reported_user_id,category,detail,reported_display_name,reported_intro)
    values(uid,shared.owner_user_id,p_category,detail,shared.display_name_snapshot,null) returning id into rid;
  insert into public.exchange_reading_report_evidence(report_id,room_id,evidence_kind,source_id,content_snapshot,content_created_at)
    values(rid,p_room_id,'shared_book_note',p_share_id,shared.note_text,shared.note_created_at);
  insert into public.exchange_reading_note_report_receipts(report_id,reporter_id,share_id) values(rid,uid,p_share_id);
  return rid;
end $$;

/*
 * P5 and P9 evidence share social_reports lifecycle metadata. The existing
 * hourly P5 job calls this function, so both use one maximum-90-day boundary.
 * Active legal/operations holds are explicit and fail closed.
 */
create or replace function public.purge_expired_conversation_report_evidence()
returns table(deleted_count bigint, remaining_expired_count bigint)
language plpgsql security definer set search_path='' as $$
declare cutoff timestamptz:=statement_timestamp()-interval '89 days 23 hours'; removed_p5 bigint:=0; removed_p9 bigint:=0;
begin
  delete from public.conversation_report_evidence evidence
  using public.social_reports report
  where report.id=evidence.report_id
    and not (report.evidence_hold_reason is not null and report.evidence_hold_released_at is null)
    and (report.created_at<=cutoff or report.review_status in('resolved','dismissed'));
  get diagnostics removed_p5=row_count;

  delete from public.exchange_reading_report_evidence evidence
  using public.social_reports report
  where report.id=evidence.report_id
    and not (report.evidence_hold_reason is not null and report.evidence_hold_released_at is null)
    and (report.created_at<=cutoff or report.review_status in('resolved','dismissed'));
  get diagnostics removed_p9=row_count;

  return query select removed_p5+removed_p9,(
    select count(*)::bigint from (
      select evidence.report_id from public.conversation_report_evidence evidence join public.social_reports report on report.id=evidence.report_id
       where not (report.evidence_hold_reason is not null and report.evidence_hold_released_at is null)
         and (report.created_at<=cutoff or report.review_status in('resolved','dismissed'))
      union all
      select evidence.report_id from public.exchange_reading_report_evidence evidence join public.social_reports report on report.id=evidence.report_id
       where not (report.evidence_hold_reason is not null and report.evidence_hold_released_at is null)
         and (report.created_at<=cutoff or report.review_status in('resolved','dismissed'))
    ) pending
  );
end $$;

create function public.set_report_evidence_hold(
  p_report_id uuid,p_reason text,p_approved_by text,p_review_at timestamptz,p_release_condition text
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_review_at<=statement_timestamp()
    or char_length(btrim(coalesce(p_reason,''))) not between 1 and 500
    or char_length(btrim(coalesce(p_approved_by,''))) not between 1 and 120
    or char_length(btrim(coalesce(p_release_condition,''))) not between 1 and 500 then
    raise exception using errcode='22023',message='Invalid evidence hold';
  end if;
  update public.social_reports set evidence_hold_reason=btrim(p_reason),evidence_hold_approved_by=btrim(p_approved_by),
    evidence_hold_started_at=statement_timestamp(),evidence_hold_review_at=p_review_at,
    evidence_hold_release_condition=btrim(p_release_condition),evidence_hold_released_at=null
  where id=p_report_id;
  return found;
end $$;

create function public.release_report_evidence_hold(p_report_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.social_reports set evidence_hold_released_at=statement_timestamp()
  where id=p_report_id and evidence_hold_reason is not null and evidence_hold_released_at is null;
  return found;
end $$;

create function public.delete_resolved_exchange_reading_report_evidence(p_report_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare removed bigint;
begin
  if not exists(
    select 1 from public.social_reports report
    where report.id=p_report_id and report.review_status in('resolved','dismissed')
      and not (report.evidence_hold_reason is not null and report.evidence_hold_released_at is null)
  ) then
    raise exception using errcode='55000',message='Report review is not complete';
  end if;
  delete from public.exchange_reading_report_evidence evidence where evidence.report_id=p_report_id;
  get diagnostics removed=row_count;
  return removed=1;
end $$;

revoke all on function public.p9a_normalize_work_text(text) from public,anon,authenticated,service_role;
revoke all on function public.p9a_lock_exchange_users(uuid[]) from public,anon,authenticated,service_role;
revoke all on function public.p9a_assert_no_exchange_blocks(uuid[]) from public,anon,authenticated,service_role;
revoke all on function public.p9a_assert_exchange_interaction_allowed(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.p9a_guard_exchange_content_write() from public,anon,authenticated,service_role;
revoke all on function public.p9a_prepare_account_delete() from public,anon,authenticated,service_role;
revoke all on function public.p9a_leave_shared_rooms_on_block() from public,anon,authenticated,service_role;
revoke all on function public.set_exchange_reading_progress_baseline(uuid,uuid,bigint,uuid,integer,boolean) from public,anon;
revoke all on function public.add_exchange_reading_book_from_invitation(uuid,uuid) from public,anon;
revoke all on function public.create_exchange_reading_room(uuid,uuid[],bigint,uuid,integer,boolean) from public,anon;
revoke all on function public.invite_exchange_reading_friends(uuid,uuid[]) from public,anon;
revoke all on function public.accept_exchange_reading_invitation(uuid,uuid,boolean,bigint,uuid,integer,boolean) from public,anon;
revoke all on function public.decline_exchange_reading_invitation(uuid) from public,anon;
revoke all on function public.decline_and_block_exchange_reading_inviter(uuid) from public,anon;
revoke all on function public.list_exchange_reading_invite_blocks() from public,anon;
revoke all on function public.unblock_exchange_reading_inviter(uuid) from public,anon;
revoke all on function public.leave_exchange_reading_room(uuid) from public,anon;
grant execute on function public.set_exchange_reading_progress_baseline(uuid,uuid,bigint,uuid,integer,boolean) to authenticated;
grant execute on function public.add_exchange_reading_book_from_invitation(uuid,uuid) to authenticated;
grant execute on function public.create_exchange_reading_room(uuid,uuid[],bigint,uuid,integer,boolean) to authenticated;
grant execute on function public.invite_exchange_reading_friends(uuid,uuid[]) to authenticated;
grant execute on function public.accept_exchange_reading_invitation(uuid,uuid,boolean,bigint,uuid,integer,boolean) to authenticated;
grant execute on function public.decline_exchange_reading_invitation(uuid) to authenticated;
grant execute on function public.decline_and_block_exchange_reading_inviter(uuid) to authenticated;
grant execute on function public.list_exchange_reading_invite_blocks() to authenticated;
grant execute on function public.unblock_exchange_reading_inviter(uuid) to authenticated;
grant execute on function public.leave_exchange_reading_room(uuid) to authenticated;
revoke all on function public.list_exchange_reading_rooms() from public,anon;
revoke all on function public.list_exchange_reading_invitations() from public,anon;
revoke all on function public.list_exchange_reading_invitable_friends(uuid) from public,anon;
revoke all on function public.get_exchange_reading_messages(uuid,timestamptz,uuid,integer) from public,anon;
revoke all on function public.send_exchange_reading_message(uuid,uuid,text) from public,anon;
revoke all on function public.mark_exchange_reading_room_read(uuid,uuid) from public,anon;
revoke all on function public.report_exchange_reading_message(uuid,uuid,text,text) from public,anon;
revoke all on function public.share_exchange_reading_note(uuid,uuid) from public,anon;
revoke all on function public.revoke_exchange_reading_note_share(uuid,uuid) from public,anon;
revoke all on function public.list_my_exchange_reading_notes(uuid) from public,anon;
revoke all on function public.list_exchange_reading_shared_notes(uuid) from public,anon;
revoke all on function public.get_exchange_reading_room_detail(uuid) from public,anon;
revoke all on function public.report_exchange_reading_shared_note(uuid,uuid,text,text) from public,anon;
grant execute on function public.list_exchange_reading_rooms() to authenticated;
grant execute on function public.list_exchange_reading_invitations() to authenticated;
grant execute on function public.list_exchange_reading_invitable_friends(uuid) to authenticated;
grant execute on function public.get_exchange_reading_messages(uuid,timestamptz,uuid,integer) to authenticated;
grant execute on function public.send_exchange_reading_message(uuid,uuid,text) to authenticated;
grant execute on function public.mark_exchange_reading_room_read(uuid,uuid) to authenticated;
grant execute on function public.report_exchange_reading_message(uuid,uuid,text,text) to authenticated;
grant execute on function public.share_exchange_reading_note(uuid,uuid) to authenticated;
grant execute on function public.revoke_exchange_reading_note_share(uuid,uuid) to authenticated;
grant execute on function public.list_my_exchange_reading_notes(uuid) to authenticated;
grant execute on function public.list_exchange_reading_shared_notes(uuid) to authenticated;
grant execute on function public.get_exchange_reading_room_detail(uuid) to authenticated;
grant execute on function public.report_exchange_reading_shared_note(uuid,uuid,text,text) to authenticated;
revoke all on function public.delete_resolved_exchange_reading_report_evidence(uuid) from public,anon,authenticated;
grant execute on function public.delete_resolved_exchange_reading_report_evidence(uuid) to service_role;
revoke all on function public.set_report_evidence_hold(uuid,text,text,timestamptz,text),public.release_report_evidence_hold(uuid) from public,anon,authenticated;
grant execute on function public.set_report_evidence_hold(uuid,text,text,timestamptz,text),public.release_report_evidence_hold(uuid) to service_role;

-- Optional account-deletion feedback is retained only as a UTC daily aggregate.
-- No user identifier, free text, or individual event row is stored.
create table public.account_deletion_reason_daily(
  deletion_date date not null,
  reason text not null check(reason in('infrequent_use','missing_features','difficult_to_use','privacy_concern','other')),
  deletion_count bigint not null default 0 check(deletion_count>=0),
  primary key(deletion_date,reason)
);
alter table public.account_deletion_reason_daily enable row level security;
revoke all on table public.account_deletion_reason_daily from public,anon,authenticated,service_role;

create function public.record_account_deletion_reason(p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_reason is null or p_reason not in('infrequent_use','missing_features','difficult_to_use','privacy_concern','other') then
    raise exception using errcode='22023',message='Invalid deletion reason';
  end if;
  insert into public.account_deletion_reason_daily(deletion_date,reason,deletion_count)
  values((statement_timestamp() at time zone 'UTC')::date,p_reason,1)
  on conflict(deletion_date,reason) do update
    set deletion_count=public.account_deletion_reason_daily.deletion_count+1;
end $$;
revoke all on function public.record_account_deletion_reason(text) from public,anon,authenticated;
grant execute on function public.record_account_deletion_reason(text) to service_role;

commit;
