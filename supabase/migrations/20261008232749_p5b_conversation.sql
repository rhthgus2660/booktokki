begin;

create extension if not exists pg_cron;

create table public.friend_messages (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  sender_display_name text not null,
  recipient_display_name text not null,
  client_id uuid not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint friend_messages_not_self check (sender_id<>recipient_id),
  constraint friend_messages_body_check check (
    char_length(body) between 1 and 1000 and body=btrim(body) and body !~ '[[:cntrl:]]'
    and char_length(translate(body,' '||chr(160)||chr(12288)||chr(8203)||chr(8204)||chr(8205)||chr(8288)||chr(65279),''))>0
  ),
  constraint friend_messages_sender_client_unique unique(sender_id,client_id)
);

create index friend_messages_connection_created_idx
  on public.friend_messages(connection_id,created_at desc,id desc);
create index friend_messages_recipient_created_idx
  on public.friend_messages(recipient_id,created_at desc);

alter table public.friend_messages enable row level security;
revoke all on table public.friend_messages from public,anon,authenticated,service_role;

create table public.conversation_report_evidence (
  report_id uuid primary key references public.social_reports(id) on delete cascade,
  connection_id uuid not null,
  message_id uuid not null unique,
  message_body text not null,
  message_created_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index conversation_report_evidence_created_idx
  on public.conversation_report_evidence(created_at desc);

alter table public.conversation_report_evidence enable row level security;
revoke all on table public.conversation_report_evidence from public,anon,authenticated,service_role;
grant select on table public.conversation_report_evidence to service_role;

create table public.conversation_report_receipts (
  report_id uuid primary key references public.social_reports(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null,
  created_at timestamptz not null default now(),
  unique(reporter_id,message_id)
);
alter table public.conversation_report_receipts enable row level security;
revoke all on table public.conversation_report_receipts from public,anon,authenticated,service_role;
grant select on table public.conversation_report_receipts to service_role;

create table public.conversation_report_retention_config (
  singleton boolean primary key default true check(singleton),
  installed_at timestamptz not null default now()
);
insert into public.conversation_report_retention_config(singleton) values(true);
alter table public.conversation_report_retention_config enable row level security;
revoke all on table public.conversation_report_retention_config from public,anon,authenticated,service_role;

create function public.list_friend_conversations()
returns table(
  connection_id uuid,
  friend_display_name text,
  friend_intro text,
  last_message text,
  last_message_at timestamptz,
  last_message_is_mine boolean,
  can_send boolean
)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query
  select conversations.connection_id,
    case when last_message.sender_id=auth.uid() then last_message.recipient_display_name else last_message.sender_display_name end,
    null::text,last_message.body,last_message.created_at,last_message.sender_id=auth.uid(),
    exists (
      select 1 from public.friend_links mine
      join public.friend_links mirror on mirror.user_id=mine.friend_user_id
        and mirror.friend_user_id=mine.user_id and mirror.connection_id=mine.connection_id
      where mine.user_id=auth.uid() and mine.connection_id=conversations.connection_id
        and not exists (
          select 1 from public.user_blocks b
          where (b.blocker_id=mine.user_id and b.blocked_id=mine.friend_user_id)
             or (b.blocker_id=mine.friend_user_id and b.blocked_id=mine.user_id)
        )
    )
  from (
    select distinct m.connection_id from public.friend_messages m
    where m.sender_id=auth.uid() or m.recipient_id=auth.uid()
  ) conversations
  join lateral (
    select m.body,m.created_at,m.sender_id,m.sender_display_name,m.recipient_display_name
    from public.friend_messages m
    where m.connection_id=conversations.connection_id
    order by m.created_at desc,m.id desc
    limit 1
  ) last_message on true
  order by last_message.created_at desc,conversations.connection_id;
end $$;

create function public.get_friend_messages(
  p_connection_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table(id uuid,body text,created_at timestamptz,sender_is_me boolean,can_send boolean)
language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); fid uuid; send_allowed boolean:=false; page_size integer:=least(greatest(coalesce(p_limit,50),1),100);
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_connection_id is null then raise exception using errcode='22004',message='Connection required'; end if;
  select l.friend_user_id into fid from public.friend_links l
  where l.user_id=uid and l.connection_id=p_connection_id;
  if fid is null then
    select case when m.sender_id=uid then m.recipient_id else m.sender_id end into fid
    from public.friend_messages m
    where m.connection_id=p_connection_id and (m.sender_id=uid or m.recipient_id=uid)
    limit 1;
  end if;
  if fid is null then raise exception using errcode='42501',message='Conversation not available'; end if;
  select exists (
    select 1 from public.friend_links mine
    join public.friend_links mirror on mirror.user_id=mine.friend_user_id
      and mirror.friend_user_id=mine.user_id and mirror.connection_id=mine.connection_id
    where mine.user_id=uid and mine.friend_user_id=fid and mine.connection_id=p_connection_id
      and not exists (
        select 1 from public.user_blocks b
        where (b.blocker_id=uid and b.blocked_id=fid) or (b.blocker_id=fid and b.blocked_id=uid)
      )
  ) into send_allowed;
  if not send_allowed and not exists (
    select 1 from public.friend_messages m
    where m.connection_id=p_connection_id and (m.sender_id=uid or m.recipient_id=uid)
  ) then raise exception using errcode='42501',message='Conversation not available'; end if;
  return query
  select page.id,page.body,page.created_at,page.sender_id=uid,send_allowed
  from (
    select m.id,m.body,m.created_at,m.sender_id
    from public.friend_messages m
    where m.connection_id=p_connection_id
      and (p_before_created_at is null or (m.created_at,m.id)<(p_before_created_at,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by m.created_at desc,m.id desc
    limit page_size
  ) page
  order by page.created_at,page.id;
end $$;

create function public.send_friend_message(p_connection_id uuid,p_client_id uuid,p_body text)
returns table(id uuid,body text,created_at timestamptz,sender_is_me boolean,can_send boolean)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); fid uuid; sender_name text; recipient_name text; message_body text:=btrim(coalesce(p_body,'')); existing public.friend_messages%rowtype;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_connection_id is null or p_client_id is null then raise exception using errcode='22004',message='Message request is incomplete'; end if;
  if char_length(message_body)<1 or char_length(message_body)>1000 or message_body~'[[:cntrl:]]'
     or char_length(translate(message_body,' '||chr(160)||chr(12288)||chr(8203)||chr(8204)||chr(8205)||chr(8288)||chr(65279),''))=0 then
    raise exception using errcode='23514',message='Message must be 1 to 1000 characters';
  end if;
  select l.friend_user_id into fid from public.friend_links l where l.user_id=uid and l.connection_id=p_connection_id;
  if fid is null then raise exception using errcode='42501',message='Conversation not available'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(least(uid,fid)::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(greatest(uid,fid)::text,0));
  if not exists (
    select 1 from public.friend_links l where l.user_id=uid and l.friend_user_id=fid and l.connection_id=p_connection_id
  ) or not exists (
    select 1 from public.friend_links l where l.user_id=fid and l.friend_user_id=uid and l.connection_id=p_connection_id
  ) or exists (
    select 1 from public.user_blocks b
    where (b.blocker_id=uid and b.blocked_id=fid) or (b.blocker_id=fid and b.blocked_id=uid)
  ) then raise exception using errcode='42501',message='Conversation not available'; end if;
  select * into existing from public.friend_messages m where m.sender_id=uid and m.client_id=p_client_id;
  if found then
    if existing.connection_id<>p_connection_id or existing.body<>message_body then
      raise sqlstate 'PT409' using message='Message request conflicts with an existing request';
    end if;
    return query select existing.id,existing.body,existing.created_at,true,true;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-rate:'||uid::text,0));
  if (select count(*) from public.friend_messages m where m.sender_id=uid and m.created_at>now()-interval '1 minute')>=20 then
    raise exception using errcode='PT429',message='Too many messages. Please wait a moment';
  end if;
  select p.display_name into sender_name from public.friend_profiles p where p.user_id=uid;
  select p.display_name into recipient_name from public.friend_profiles p where p.user_id=fid;
  if sender_name is null or recipient_name is null then
    raise exception using errcode='23514',message='Conversation profile unavailable';
  end if;
  insert into public.friend_messages(connection_id,sender_id,recipient_id,sender_display_name,recipient_display_name,client_id,body)
  values(p_connection_id,uid,fid,sender_name,recipient_name,p_client_id,message_body)
  returning friend_messages.id,friend_messages.body,friend_messages.created_at into existing.id,existing.body,existing.created_at;
  return query select existing.id,existing.body,existing.created_at,true,true;
end $$;

create function public.report_friend_message(
  p_connection_id uuid,
  p_message_id uuid,
  p_category text,
  p_detail text default null
)
returns uuid
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); reported_message public.friend_messages%rowtype; rid uuid;
  detail text:=nullif(btrim(coalesce(p_detail,'')),''); existing_category text; existing_detail text;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_connection_id is null or p_message_id is null then raise exception using errcode='22004',message='Report request is incomplete'; end if;
  if p_category not in('spam','harassment','inappropriate_content','other') then
    raise exception using errcode='23514',message='Invalid report category';
  end if;
  if detail is not null and (char_length(detail)>500 or detail~'[[:cntrl:]]') then
    raise exception using errcode='23514',message='Report detail must be at most 500 plain text characters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_message_id::text,0));
  select m.* into reported_message from public.friend_messages m
  where m.id=p_message_id and m.connection_id=p_connection_id
    and m.recipient_id=uid and m.sender_id<>uid;
  if not found then raise exception using errcode='42501',message='Report message unavailable'; end if;

  select r.id,r.category,r.detail into rid,existing_category,existing_detail
  from public.conversation_report_receipts receipt
  join public.social_reports r on r.id=receipt.report_id
  where receipt.message_id=p_message_id and receipt.reporter_id=uid;
  if found then
    if existing_category<>p_category or existing_detail is distinct from detail then
      raise sqlstate 'PT409' using message='Message report already submitted';
    end if;
    return rid;
  end if;

  insert into public.social_reports(
    reporter_id,reported_user_id,category,detail,reported_display_name,reported_intro
  ) values(
    uid,reported_message.sender_id,p_category,detail,reported_message.sender_display_name,null
  ) returning id into rid;
  insert into public.conversation_report_evidence(
    report_id,connection_id,message_id,message_body,message_created_at
  ) values(
    rid,p_connection_id,p_message_id,reported_message.body,reported_message.created_at
  );
  insert into public.conversation_report_receipts(report_id,reporter_id,message_id)
  values(rid,uid,p_message_id);
  return rid;
end $$;

create function public.purge_expired_conversation_report_evidence()
returns table(deleted_count bigint, remaining_expired_count bigint)
language plpgsql security definer set search_path='' as $$
declare cutoff timestamptz:=statement_timestamp()-interval '89 days 23 hours'; removed bigint;
begin
  delete from public.conversation_report_evidence e
  using public.social_reports r
  where r.id=e.report_id and r.created_at<=cutoff;
  get diagnostics removed=row_count;

  return query
  select removed,count(*)::bigint
  from public.conversation_report_evidence e
  join public.social_reports r on r.id=e.report_id
  where r.created_at<=cutoff;
end $$;

revoke all on function public.list_friend_conversations(),public.get_friend_messages(uuid,timestamptz,uuid,integer),public.send_friend_message(uuid,uuid,text),public.report_friend_message(uuid,uuid,text,text) from public,anon;
grant execute on function public.list_friend_conversations(),public.get_friend_messages(uuid,timestamptz,uuid,integer),public.send_friend_message(uuid,uuid,text),public.report_friend_message(uuid,uuid,text,text) to authenticated;
revoke all on function public.purge_expired_conversation_report_evidence() from public,anon,authenticated;
grant execute on function public.purge_expired_conversation_report_evidence() to service_role;

create function public.assert_conversation_report_retention_health()
returns void
language plpgsql security definer set search_path='' as $$
declare last_success timestamptz;
  installed_at timestamptz;
begin
  select max(d.end_time) into last_success
  from cron.job_run_details d
  join cron.job j on j.jobid=d.jobid
  where j.jobname='p5b-report-evidence-retention-hourly'
    and d.status='succeeded';
  select c.installed_at into installed_at from public.conversation_report_retention_config c where c.singleton=true;
  if last_success is null and installed_at>statement_timestamp()-interval '2 hours' then return; end if;
  if last_success is null or last_success<statement_timestamp()-interval '2 hours' then
    raise exception using errcode='P0001',message='P5-B report retention purge has no recent successful run';
  end if;
end $$;
revoke all on function public.assert_conversation_report_retention_health() from public,anon,authenticated,service_role;

select cron.schedule(
  'p5b-report-evidence-retention-hourly',
  '7 * * * *',
  'select public.purge_expired_conversation_report_evidence()'
);
select cron.schedule(
  'p5b-report-evidence-retention-watchdog',
  '17 * * * *',
  'select public.assert_conversation_report_retention_health()'
);

commit;
