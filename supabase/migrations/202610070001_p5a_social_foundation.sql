begin;

alter table public.friend_profiles add column if not exists intro text;
alter table public.friend_profiles drop constraint if exists friend_profiles_intro_check;
alter table public.friend_profiles add constraint friend_profiles_intro_check check (
  intro is null or (char_length(intro) <= 60 and intro !~ '[[:cntrl:]]')
);

/* One-time compatibility backfill. Auth metadata is copied as profile content only;
   it is never used for authorization and an existing social profile always wins. */
insert into public.friend_profiles(user_id,display_name)
select u.id, btrim(u.raw_user_meta_data->>'booktokki_nickname')
from auth.users u
where nullif(btrim(u.raw_user_meta_data->>'booktokki_nickname'),'') is not null
  and char_length(btrim(u.raw_user_meta_data->>'booktokki_nickname')) <= 20
  and btrim(u.raw_user_meta_data->>'booktokki_nickname') !~ '[[:cntrl:]]'
on conflict(user_id) do nothing;

create table public.user_blocks(
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  source_connection_id uuid not null,
  blocked_display_name text not null,
  blocked_intro text,
  created_at timestamptz not null default now(),
  primary key(blocker_id,blocked_id),
  constraint user_blocks_not_self check(blocker_id<>blocked_id)
);
create index user_blocks_blocked_idx on public.user_blocks(blocked_id);

create table public.social_reports(
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check(category in ('spam','harassment','inappropriate_content','other')),
  detail text,
  reported_display_name text not null,
  reported_intro text,
  review_status text not null default 'received' check(review_status in ('received','reviewing','resolved','dismissed')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint social_reports_not_self check(reporter_id<>reported_user_id),
  constraint social_reports_detail_check check(detail is null or (char_length(detail)<=500 and detail !~ '[[:cntrl:]]'))
);
create index social_reports_reported_idx on public.social_reports(reported_user_id,created_at desc);
create index social_reports_created_idx on public.social_reports(created_at desc);

alter table public.user_blocks enable row level security;
alter table public.social_reports enable row level security;
revoke all on table public.friend_profiles,public.user_blocks,public.social_reports from public,anon,authenticated;
revoke all on table public.user_blocks from service_role;
revoke all on table public.social_reports from service_role;
grant select on table public.social_reports to service_role;
grant update(review_status,reviewed_at) on table public.social_reports to service_role;

create or replace function public.get_my_social_profile()
returns table(display_name text,intro text)
language sql stable security definer set search_path=''
as $$ select p.display_name,p.intro from public.friend_profiles p where p.user_id=auth.uid() and auth.uid() is not null $$;

create or replace function public.update_my_social_profile(p_display_name text,p_intro text default null)
returns table(display_name text,intro text)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); nm text:=btrim(coalesce(p_display_name,'')); bio text:=nullif(btrim(coalesce(p_intro,'')),'');
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if nm='' or char_length(nm)>20 or nm ~ '[[:cntrl:]]' then raise exception using errcode='23514',message='Display name must be 1-20 plain text characters'; end if;
  if bio is not null and (char_length(bio)>60 or bio ~ '[[:cntrl:]]') then raise exception using errcode='23514',message='Intro must be at most 60 plain text characters'; end if;
  insert into public.friend_profiles(user_id,display_name,intro) values(uid,nm,bio)
  on conflict(user_id) do update set display_name=excluded.display_name,intro=excluded.intro;
  return query select p.display_name,p.intro from public.friend_profiles p where p.user_id=uid;
end $$;

/* OUT columns are part of a PostgreSQL function's return type. */
drop function public.get_friend_connections();
create function public.get_friend_connections()
returns table(connection_id uuid,friend_display_name text,friend_intro text,connected_at timestamptz,my_visit_state text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query select l.connection_id,p.display_name,p.intro,l.connected_at,
    case when c.allowed and c.consent_version=1 then 'allowed' when c.allowed=false and c.consent_version=1 then 'declined' else 'undecided' end
  from public.friend_links l join public.friend_profiles p on p.user_id=l.friend_user_id
  left join public.friend_visit_consents c on c.user_id=l.user_id and c.connection_id=l.connection_id
  where l.user_id=auth.uid()
    and not exists(select 1 from public.user_blocks b where (b.blocker_id=l.user_id and b.blocked_id=l.friend_user_id) or (b.blocker_id=l.friend_user_id and b.blocked_id=l.user_id))
  order by l.connected_at,l.connection_id;
end $$;

create function public.get_friend_profile(p_connection_id uuid)
returns table(display_name text,intro text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query select p.display_name,p.intro from public.friend_links l join public.friend_profiles p on p.user_id=l.friend_user_id
  where l.user_id=auth.uid() and l.connection_id=p_connection_id
    and not exists(select 1 from public.user_blocks b where (b.blocker_id=l.user_id and b.blocked_id=l.friend_user_id) or (b.blocker_id=l.friend_user_id and b.blocked_id=l.user_id));
end $$;

create or replace function public.touch_friend_presence()
returns table(connection_id uuid,friend_display_name text)
language plpgsql security definer set search_path='' as $$
declare has_mutual boolean; bucket bigint:=floor(extract(epoch from now())/1800)::bigint;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select exists(select 1 from public.friend_links l
    join public.friend_visit_consents m on m.user_id=l.user_id and m.connection_id=l.connection_id and m.allowed and m.consent_version=1
    join public.friend_visit_consents t on t.user_id=l.friend_user_id and t.connection_id=l.connection_id and t.allowed and t.consent_version=1
    where l.user_id=auth.uid() and not exists(select 1 from public.user_blocks b where (b.blocker_id=l.user_id and b.blocked_id=l.friend_user_id) or (b.blocker_id=l.friend_user_id and b.blocked_id=l.user_id))) into has_mutual;
  if has_mutual then insert into public.app_presence(user_id,last_seen_at) values(auth.uid(),now()) on conflict(user_id) do update set last_seen_at=excluded.last_seen_at where public.app_presence.last_seen_at<now()-interval '20 seconds';
  else delete from public.app_presence where user_id=auth.uid(); end if;
  delete from public.app_presence where last_seen_at<now()-interval '15 minutes';
  insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at)
  select 'overlap:'||l.connection_id::text||':'||bucket::text,least(l.user_id,l.friend_user_id),'friend_overlap',now()
  from public.friend_links l
  join public.friend_visit_consents m on m.user_id=l.user_id and m.connection_id=l.connection_id and m.allowed and m.consent_version=1
  join public.friend_visit_consents t on t.user_id=l.friend_user_id and t.connection_id=l.connection_id and t.allowed and t.consent_version=1
  join public.app_presence a on a.user_id=l.friend_user_id and a.last_seen_at>now()-interval '3 minutes'
  where l.user_id=auth.uid() and not exists(select 1 from public.user_blocks b where (b.blocker_id=l.user_id and b.blocked_id=l.friend_user_id) or (b.blocker_id=l.friend_user_id and b.blocked_id=l.user_id))
  on conflict do nothing;
  return query select l.connection_id,p.display_name from public.friend_links l join public.friend_profiles p on p.user_id=l.friend_user_id
    join public.friend_visit_consents m on m.user_id=l.user_id and m.connection_id=l.connection_id and m.allowed and m.consent_version=1
    join public.friend_visit_consents t on t.user_id=l.friend_user_id and t.connection_id=l.connection_id and t.allowed and t.consent_version=1
    join public.app_presence a on a.user_id=l.friend_user_id and a.last_seen_at>now()-interval '3 minutes'
    where l.user_id=auth.uid() and not exists(select 1 from public.user_blocks b where (b.blocker_id=l.user_id and b.blocked_id=l.friend_user_id) or (b.blocker_id=l.friend_user_id and b.blocked_id=l.user_id));
end $$;

create or replace function public.preview_friend_invite(p_token text)
returns text language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); hash text; inviter uuid; nm text;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_token is null or char_length(p_token)<>64 or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  hash:=encode(extensions.digest(p_token,'sha256'),'hex');
  select i.inviter_user_id,p.display_name into inviter,nm from public.friend_invites i join public.friend_profiles p on p.user_id=i.inviter_user_id where i.token_hash=hash and i.expires_at>now();
  if inviter is null or exists(select 1 from public.user_blocks b where (b.blocker_id=uid and b.blocked_id=inviter) or (b.blocker_id=inviter and b.blocked_id=uid)) then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  return nm;
end $$;

create function public.block_friend_connection(p_connection_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); fid uuid; low uuid; high uuid; link_still_exists boolean; snap_name text; snap_intro text;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select l.friend_user_id into fid from public.friend_links l where l.user_id=uid and l.connection_id=p_connection_id;
  if fid is null then select b.blocker_id into fid from public.user_blocks b where b.blocked_id=uid and b.source_connection_id=p_connection_id; end if;
  if fid is null then return false; end if;
  low:=least(uid,fid); high:=greatest(uid,fid);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(low::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(high::text,0));
  select exists(select 1 from public.friend_links l where l.user_id=uid and l.friend_user_id=fid and l.connection_id=p_connection_id for update) into link_still_exists;
  if not link_still_exists and not exists(select 1 from public.user_blocks b where b.blocker_id=fid and b.blocked_id=uid) then return false; end if;
  select p.display_name,p.intro into snap_name,snap_intro from public.friend_profiles p where p.user_id=fid;
  if snap_name is null then raise exception using errcode='23514',message='Friend profile unavailable'; end if;
  insert into public.user_blocks(blocker_id,blocked_id,source_connection_id,blocked_display_name,blocked_intro)
  values(uid,fid,p_connection_id,snap_name,snap_intro) on conflict do nothing;
  if link_still_exists then delete from public.friend_links where connection_id=p_connection_id; end if;
  delete from public.app_presence a where a.user_id in(uid,fid) and not exists(
    select 1 from public.friend_links l join public.friend_visit_consents m on m.user_id=l.user_id and m.connection_id=l.connection_id and m.allowed and m.consent_version=1
    join public.friend_visit_consents t on t.user_id=l.friend_user_id and t.connection_id=l.connection_id and t.allowed and t.consent_version=1 where l.user_id=a.user_id);
  return true;
end $$;

create function public.get_blocked_users()
returns table(block_handle uuid,display_name text,intro text,blocked_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query select b.source_connection_id,b.blocked_display_name,b.blocked_intro,b.created_at
  from public.user_blocks b where b.blocker_id=auth.uid() order by b.created_at desc;
end $$;

create function public.unblock_user(p_block_handle uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  delete from public.user_blocks where blocker_id=auth.uid() and source_connection_id=p_block_handle; get diagnostics n=row_count; return n=1;
end $$;

create function public.report_friend_connection(p_connection_id uuid,p_category text,p_detail text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); fid uuid; rid uuid; detail text:=nullif(btrim(coalesce(p_detail,'')),''); snap_name text; snap_intro text;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_category not in('spam','harassment','inappropriate_content','other') then raise exception using errcode='23514',message='Invalid report category'; end if;
  if detail is not null and (char_length(detail)>500 or detail ~ '[[:cntrl:]]') then raise exception using errcode='23514',message='Report detail must be at most 500 plain text characters'; end if;
  select l.friend_user_id,p.display_name,p.intro into fid,snap_name,snap_intro from public.friend_links l join public.friend_profiles p on p.user_id=l.friend_user_id where l.user_id=uid and l.connection_id=p_connection_id;
  if fid is null then raise exception using errcode='42501',message='Connection not available'; end if;
  insert into public.social_reports(reporter_id,reported_user_id,category,detail,reported_display_name,reported_intro) values(uid,fid,p_category,detail,snap_name,snap_intro) returning id into rid; return rid;
end $$;

/* A block is also enforced at the reconnect boundary. */
create or replace function public.accept_friend_invite(p_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); inv public.friend_invites%rowtype; inviter uuid; hash text; cid uuid:=gen_random_uuid(); low uuid; high uuid;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_token is null or char_length(p_token)<>64 or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  hash:=encode(extensions.digest(p_token,'sha256'),'hex'); select inviter_user_id into inviter from public.friend_invites where token_hash=hash;
  if inviter is null then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  if inviter=uid then raise exception using errcode='23514',message='Cannot connect to yourself'; end if;
  if exists(select 1 from public.user_blocks b where (b.blocker_id=uid and b.blocked_id=inviter) or (b.blocker_id=inviter and b.blocked_id=uid)) then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  low:=least(uid,inviter);high:=greatest(uid,inviter);perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(low::text,0));perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(high::text,0));
  if exists(select 1 from public.user_blocks b where (b.blocker_id=uid and b.blocked_id=inviter) or (b.blocker_id=inviter and b.blocked_id=uid)) then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  select * into inv from public.friend_invites where token_hash=hash for update;
  if not found or inv.expires_at<=now() then raise exception using errcode='PT404',message='Invite not found or expired'; end if;
  if exists(select 1 from public.friend_links where user_id=uid and friend_user_id=inviter) then raise sqlstate 'PT409' using message='Friend already connected'; end if;
  if not exists(select 1 from public.friend_profiles where user_id=uid) or not exists(select 1 from public.friend_profiles where user_id=inviter) then raise exception using errcode='23514',message='Both friend display names are required'; end if;
  insert into public.friend_links(user_id,friend_user_id,connection_id) values(uid,inviter,cid),(inviter,uid,cid); delete from public.friend_invites where id=inv.id; return cid;
end $$;

revoke all on function public.get_my_social_profile(),public.update_my_social_profile(text,text),public.get_friend_connections(),public.get_friend_profile(uuid),public.touch_friend_presence(),public.preview_friend_invite(text),public.block_friend_connection(uuid),public.get_blocked_users(),public.unblock_user(uuid),public.report_friend_connection(uuid,text,text),public.accept_friend_invite(text) from public,anon;
grant execute on function public.get_my_social_profile(),public.update_my_social_profile(text,text),public.get_friend_connections(),public.get_friend_profile(uuid),public.touch_friend_presence(),public.preview_friend_invite(text),public.block_friend_connection(uuid),public.get_blocked_users(),public.unblock_user(uuid),public.report_friend_connection(uuid,text,text),public.accept_friend_invite(text) to authenticated;

commit;
