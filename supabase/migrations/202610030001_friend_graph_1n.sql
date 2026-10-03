begin;

set local lock_timeout = '5s';

/* PR1-A: expand mirrored friend_links and consent to connection-scoped 1:N. */
lock table public.friend_links, public.friend_invites, public.friend_visit_consents in access exclusive mode;

do $$
declare
  bad integer;
  orphan integer;
begin
  select count(*) into bad
  from (
    select user_id
    from public.friend_links
    group by user_id
    having count(*) > 1
  ) q;
  if bad <> 0 then
    raise exception 'friend graph preflight failed: % user(s) already have multiple connections', bad;
  end if;

  select count(*) into bad
  from (
    select connection_id
    from public.friend_links
    group by connection_id
    having count(*) <> 2
  ) q;
  if bad <> 0 then
    raise exception 'friend graph preflight failed: % connection(s) are not mirrored pairs', bad;
  end if;

  select count(*) into bad
  from public.friend_links a
  where not exists (
    select 1 from public.friend_links b
    where b.connection_id = a.connection_id
      and b.user_id = a.friend_user_id
      and b.friend_user_id = a.user_id
  );
  if bad <> 0 then
    raise exception 'friend graph preflight failed: % malformed mirrored row(s)', bad;
  end if;

  select count(*) into orphan
  from public.friend_visit_consents c
  where not exists (
    select 1 from public.friend_links l where l.connection_id = c.connection_id
  );
  raise notice 'friend graph preflight: % orphan consent row(s) retained', orphan;

  select count(*) into bad
  from public.friend_visit_consents c
  where exists (select 1 from public.friend_links l where l.connection_id = c.connection_id)
    and not exists (
      select 1 from public.friend_links l
      where l.connection_id = c.connection_id and l.user_id = c.user_id
    );
  if bad <> 0 then
    raise exception 'friend graph preflight failed: % consent row(s) have invalid connection ownership', bad;
  end if;
end $$;

alter table public.friend_links drop constraint if exists friend_links_pkey;
alter table public.friend_links drop constraint if exists friend_links_friend_user_id_key;
alter table public.friend_links add constraint friend_links_pkey primary key (user_id, friend_user_id);

alter table public.friend_links
  add constraint friend_links_mirror_fk
  foreign key (connection_id, friend_user_id)
  references public.friend_links (connection_id, user_id)
  deferrable initially deferred;

alter table public.friend_visit_consents drop constraint if exists friend_visit_consents_pkey;
alter table public.friend_visit_consents add constraint friend_visit_consents_pkey primary key (user_id, connection_id);
alter table public.friend_visit_consents
  add constraint friend_visit_consents_connection_fk
  foreign key (connection_id, user_id)
  references public.friend_links (connection_id, user_id)
  on delete cascade not valid;

/* Collection API: only current visitors are returned; absent friends are omitted. */
create or replace function public.get_friend_connections()
returns table(connection_id uuid, friend_display_name text, connected_at timestamptz, my_visit_state text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  return query
  select l.connection_id, p.display_name, l.connected_at,
    case when c.allowed is true and c.consent_version = 1 then 'allowed'
         when c.allowed is false and c.consent_version = 1 then 'declined'
         else 'undecided' end
  from public.friend_links l
  join public.friend_profiles p on p.user_id = l.friend_user_id
  left join public.friend_visit_consents c on c.user_id = l.user_id and c.connection_id = l.connection_id
  where l.user_id = auth.uid()
  order by l.connected_at, l.connection_id;
end;
$$;

create or replace function public.set_friend_connection_visit(p_connection_id uuid, p_allowed boolean)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_connection_id is null or p_allowed is null then raise exception using errcode='23514', message='Visit consent decision required'; end if;
  if not exists (select 1 from public.friend_links where connection_id=p_connection_id and user_id=auth.uid()) then
    raise exception using errcode='42501', message='Connection not available';
  end if;
  insert into public.friend_visit_consents(user_id,connection_id,allowed,consent_version,decided_at)
  values(auth.uid(),p_connection_id,p_allowed,1,now())
  on conflict(user_id,connection_id) do update set allowed=excluded.allowed,consent_version=excluded.consent_version,decided_at=excluded.decided_at;
  if not p_allowed and not exists (
    select 1 from public.friend_links l
    join public.friend_visit_consents mine on mine.user_id=l.user_id and mine.connection_id=l.connection_id and mine.allowed and mine.consent_version=1
    join public.friend_visit_consents theirs on theirs.user_id=l.friend_user_id and theirs.connection_id=l.connection_id and theirs.allowed and theirs.consent_version=1
    where l.user_id=auth.uid() and l.connection_id<>p_connection_id
  ) then delete from public.app_presence where user_id=auth.uid(); end if;
  return case when p_allowed then 'allowed' else 'declined' end;
end;
$$;

create or replace function public.touch_friend_presence()
returns table(connection_id uuid, friend_display_name text)
language plpgsql security definer set search_path = '' as $$
declare
  v_has_mutual boolean;
  v_bucket bigint := floor(extract(epoch from now()) / 1800)::bigint;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select exists(
    select 1 from public.friend_links l
    join public.friend_visit_consents mine on mine.user_id=l.user_id and mine.connection_id=l.connection_id and mine.allowed and mine.consent_version=1
    join public.friend_visit_consents theirs on theirs.user_id=l.friend_user_id and theirs.connection_id=l.connection_id and theirs.allowed and theirs.consent_version=1
    where l.user_id=auth.uid()
  ) into v_has_mutual;
  if v_has_mutual then
    insert into public.app_presence(user_id,last_seen_at) values(auth.uid(),now())
    on conflict(user_id) do update set last_seen_at=excluded.last_seen_at
    where public.app_presence.last_seen_at < now() - interval '20 seconds';
  else
    delete from public.app_presence where user_id=auth.uid();
  end if;
  delete from public.app_presence where last_seen_at < now()-interval '15 minutes';

  insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at)
  select
    'overlap:' || fl.connection_id::text || ':' || v_bucket::text,
    least(fl.user_id, fl.friend_user_id),
    'friend_overlap',
    now()
  from public.friend_links fl
  join public.friend_visit_consents mine
    on mine.user_id=fl.user_id and mine.connection_id=fl.connection_id and mine.allowed and mine.consent_version=1
  join public.friend_visit_consents theirs
    on theirs.user_id=fl.friend_user_id and theirs.connection_id=fl.connection_id and theirs.allowed and theirs.consent_version=1
  join public.app_presence other
    on other.user_id=fl.friend_user_id and other.last_seen_at > now()-interval '3 minutes'
  where fl.user_id=auth.uid()
  on conflict do nothing;

  return query
  select fl.connection_id, fp.display_name
  from public.friend_links fl
  join public.friend_profiles fp on fp.user_id=fl.friend_user_id
  join public.friend_visit_consents mine on mine.user_id=fl.user_id and mine.connection_id=fl.connection_id and mine.allowed and mine.consent_version=1
  join public.friend_visit_consents theirs on theirs.user_id=fl.friend_user_id and theirs.connection_id=fl.connection_id and theirs.allowed and theirs.consent_version=1
  join public.app_presence other on other.user_id=fl.friend_user_id and other.last_seen_at > now()-interval '3 minutes'
  where fl.user_id=auth.uid();
end;
$$;

create or replace function public.disconnect_friend_connection(p_connection_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_friend_id uuid;
  v_low uuid;
  v_high uuid;
begin
  if v_user_id is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_connection_id is null then return false; end if;

  select fl.friend_user_id into v_friend_id
  from public.friend_links fl
  where fl.connection_id=p_connection_id and fl.user_id=v_user_id;
  if not found then return false; end if;

  v_low := least(v_user_id,v_friend_id);
  v_high := greatest(v_user_id,v_friend_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_low::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_high::text,0));

  if not exists (
    select 1 from public.friend_links fl
    where fl.connection_id=p_connection_id and fl.user_id=v_user_id and fl.friend_user_id=v_friend_id
  ) then return false; end if;

  delete from public.friend_links fl where fl.connection_id=p_connection_id;

  delete from public.app_presence ap
  where ap.user_id in (v_user_id,v_friend_id)
    and not exists (
      select 1
      from public.friend_links fl
      join public.friend_visit_consents mine
        on mine.user_id=fl.user_id and mine.connection_id=fl.connection_id and mine.allowed and mine.consent_version=1
      join public.friend_visit_consents theirs
        on theirs.user_id=fl.friend_user_id and theirs.connection_id=fl.connection_id and theirs.allowed and theirs.consent_version=1
      where fl.user_id=ap.user_id
    );
  return true;
end;
$$;

create or replace function public.record_friend_rabbit_seen_v2(p_connection_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare fid uuid; inserted integer;
begin
  if auth.uid() is null or p_connection_id is null then return false; end if;
  select friend_user_id into fid from public.friend_links where connection_id=p_connection_id and user_id=auth.uid();
  if fid is null then return false; end if;
  if not exists(select 1 from public.friend_visit_consents where user_id=auth.uid() and connection_id=p_connection_id and allowed and consent_version=1)
     or not exists(select 1 from public.friend_visit_consents where user_id=fid and connection_id=p_connection_id and allowed and consent_version=1)
     or not exists(select 1 from public.app_presence where user_id=auth.uid() and last_seen_at>now()-interval '3 minutes')
     or not exists(select 1 from public.app_presence where user_id=fid and last_seen_at>now()-interval '3 minutes') then return false; end if;
  insert into public.presence_analytics_events(event_id,user_id,event_type,occurred_at)
  values('rabbit-seen:'||p_connection_id::text||':'||floor(extract(epoch from now())/1800)::bigint,auth.uid(),'friend_rabbit_seen',now()) on conflict do nothing;
  get diagnostics inserted=row_count;
  return inserted=1;
end;
$$;

/* Legacy wrappers remain safe and neutral once a user has >1 connection. */
create or replace function public.disconnect_friend() returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*) into n from public.friend_links fl where fl.user_id=auth.uid();
  if n=0 then return false; elsif n>1 then raise exception using errcode='PT409', message='Multiple friends require a connection id'; end if;
  select fl.connection_id into cid from public.friend_links fl where fl.user_id=auth.uid() limit 1;
  return public.disconnect_friend_connection(cid);
end; $$;

create or replace function public.set_friend_visit_allowed(p_allowed boolean) returns text language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*) into n from public.friend_links fl where fl.user_id=auth.uid();
  if n=0 then raise exception using errcode='23514', message='Friend connection required'; elsif n>1 then raise exception using errcode='PT409', message='Multiple friends require a connection id'; end if;
  select fl.connection_id into cid from public.friend_links fl where fl.user_id=auth.uid() limit 1;
  return public.set_friend_connection_visit(cid,p_allowed);
end; $$;

create or replace function public.touch_app_presence() returns table(connected boolean,friend_display_name text,visit_state text,friend_here boolean)
language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid; nm text; state text;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*) into n from public.friend_links fl where fl.user_id=auth.uid();
  if n>1 then return query select true,null::text,'none'::text,false; return; end if;
  if n=0 then return query select false,null::text,'none'::text,false; return; end if;
  select fl.connection_id into cid from public.friend_links fl where fl.user_id=auth.uid() limit 1;
  select g.friend_display_name,g.my_visit_state into nm,state
  from public.get_friend_connections() g where g.connection_id=cid;
  if state='undecided' then state:='needs_consent'; end if;
  return query select true,nm,state,exists(select 1 from public.touch_friend_presence() v where v.connection_id=cid);
end; $$;

create or replace function public.record_friend_rabbit_seen() returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*) into n from public.friend_links fl where fl.user_id=auth.uid();
  if n<>1 then return false; end if;
  select fl.connection_id into cid from public.friend_links fl where fl.user_id=auth.uid() limit 1;
  return public.record_friend_rabbit_seen_v2(cid);
end; $$;

create or replace function public.get_co_reading_presence() returns table(connected boolean,friend_display_name text,current_user_reading boolean,friend_reading boolean,co_reading boolean)
language plpgsql stable security definer set search_path='' as $$
declare n integer; cid uuid; nm text;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*) into n from public.friend_links fl where fl.user_id=auth.uid();
  if n=0 then return query select false,null::text,false,false,false; return; end if;
  if n>1 then return query select true,null::text,false,false,false; return; end if;
  select fl.connection_id into cid from public.friend_links fl where fl.user_id=auth.uid() limit 1;
  select g.friend_display_name into nm from public.get_friend_connections() g where g.connection_id=cid;
  return query select true,nm,false,false,false;
end; $$;

/* Invite changes: one active invite per inviter, but no one-friend restriction. */
create or replace function public.create_friend_invite() returns text language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); token text; hash text;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if not exists(select 1 from public.friend_profiles where user_id=uid) then raise exception using errcode='23514',message='Friend display name required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,0));
  token:=encode(extensions.gen_random_bytes(32),'hex'); hash:=encode(extensions.digest(token,'sha256'),'hex');
  delete from public.friend_invites where inviter_user_id=uid;
  insert into public.friend_invites(inviter_user_id,token_hash) values(uid,hash);
  return token;
end; $$;

create or replace function public.accept_friend_invite(p_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); inv public.friend_invites%rowtype; inviter uuid; hash text; cid uuid:=gen_random_uuid(); low uuid; high uuid;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_token is null or char_length(p_token)<>64 or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='P0002',message='Invite not found or expired'; end if;
  hash:=encode(extensions.digest(p_token,'sha256'),'hex');
  select fi.inviter_user_id into inviter from public.friend_invites fi where fi.token_hash=hash;
  if not found then raise exception using errcode='P0002',message='Invite not found or expired'; end if;
  if inviter=uid then raise exception using errcode='23514',message='Cannot connect to yourself'; end if;
  low:=least(uid,inviter); high:=greatest(uid,inviter);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(low::text,0)); perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(high::text,0));
  select * into inv from public.friend_invites fi where fi.token_hash=hash for update;
  if not found or inv.expires_at<=now() or inv.inviter_user_id<>inviter then raise exception using errcode='P0002',message='Invite not found or expired'; end if;
  if exists(select 1 from public.friend_links where user_id=uid and friend_user_id=inviter) then raise sqlstate 'PT409' using message='Friend already connected'; end if;
  if not exists(select 1 from public.friend_profiles where user_id=uid) or not exists(select 1 from public.friend_profiles where user_id=inviter) then raise exception using errcode='23514',message='Both friend display names are required'; end if;
  insert into public.friend_links(user_id,friend_user_id,connection_id) values(uid,inviter,cid),(inviter,uid,cid);
  delete from public.friend_invites where id=inv.id;
  return cid;
end; $$;

/* Measurement snapshot keeps explicit side counts for 1:N semantics. */
drop view if exists public.measurement_friend_visit_snapshot;
create view public.measurement_friend_visit_snapshot with (security_invoker=true) as
with connections as (select connection_id from public.friend_links group by connection_id having count(*)=2), consents as (select c.* from public.friend_visit_consents c join public.friend_links l on l.user_id=c.user_id and l.connection_id=c.connection_id where c.consent_version=1)
select
 (select count(*) from connections) as connected_pairs,
 (select count(*) from connections x where (select count(*) from consents c where c.connection_id=x.connection_id and c.allowed)=2) as mutual_allowed_pairs,
 (select count(*) from consents where not allowed) as declined_sides,
 (select count(*) from public.friend_links l where not exists(select 1 from consents c where c.user_id=l.user_id and c.connection_id=l.connection_id)) as undecided_sides;

revoke all on public.measurement_friend_visit_snapshot from public,anon,authenticated;
grant select on public.measurement_friend_visit_snapshot to service_role;

revoke all on function public.get_friend_connections() from public,anon;
revoke all on function public.touch_friend_presence() from public,anon;
revoke all on function public.set_friend_connection_visit(uuid,boolean) from public,anon;
revoke all on function public.disconnect_friend_connection(uuid) from public,anon;
revoke all on function public.record_friend_rabbit_seen_v2(uuid) from public,anon;
grant execute on function public.get_friend_connections() to authenticated;
grant execute on function public.touch_friend_presence() to authenticated;
grant execute on function public.set_friend_connection_visit(uuid,boolean) to authenticated;
grant execute on function public.disconnect_friend_connection(uuid) to authenticated;
grant execute on function public.record_friend_rabbit_seen_v2(uuid) to authenticated;

commit;
