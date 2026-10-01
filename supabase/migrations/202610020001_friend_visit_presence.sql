begin;

/*
 * P5 Step 3 — Friend Visit Presence foundation.
 *
 * This stores only one current app-presence timestamp per mutually consenting
 * user. It exposes no timestamp, friend user id, screen, book, page, note, or
 * presence history to clients. Existing reading data and sync paths are
 * intentionally untouched.
 */

create table public.app_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null
);

create index app_presence_last_seen_at_idx
on public.app_presence(last_seen_at);

create table public.friend_visit_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  connection_id uuid not null,
  allowed boolean not null,
  consent_version smallint not null check (consent_version >= 1),
  decided_at timestamptz not null default now()
);

alter table public.app_presence enable row level security;
alter table public.friend_visit_consents enable row level security;

revoke all on table public.app_presence from public, anon, authenticated;
revoke all on table public.friend_visit_consents from public, anon, authenticated;

/* New presence measurements are written only by the RPCs below. */
alter table public.presence_analytics_events
  drop constraint presence_analytics_events_event_type_check;

alter table public.presence_analytics_events
  add constraint presence_analytics_events_event_type_check
  check (event_type in (
    'reading_presence_started',
    'co_reading_seen',
    'friend_overlap',
    'friend_rabbit_seen'
  ));

drop policy if exists presence_analytics_insert_own_co_reading_seen
on public.presence_analytics_events;

revoke insert on table public.presence_analytics_events from authenticated;

/* Reading-specific presence is retired without dropping its stored objects. */
revoke execute on function public.start_reading_presence() from authenticated;
revoke execute on function public.stop_reading_presence() from authenticated;

create function public.set_friend_visit_allowed(p_allowed boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_connection_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_allowed is null then
    raise exception using errcode = '23514', message = 'Visit consent decision required';
  end if;

  select connection_id into v_connection_id
  from public.friend_links
  where user_id = v_user_id;

  if not found then
    raise exception using errcode = '23514', message = 'Friend connection required';
  end if;

  insert into public.friend_visit_consents (
    user_id, connection_id, allowed, consent_version, decided_at
  ) values (
    v_user_id, v_connection_id, p_allowed, 1, now()
  )
  on conflict (user_id) do update
  set connection_id = excluded.connection_id,
      allowed = excluded.allowed,
      consent_version = excluded.consent_version,
      decided_at = excluded.decided_at;

  if not p_allowed then
    delete from public.app_presence where user_id = v_user_id;
    return 'declined';
  end if;

  return 'allowed';
end;
$$;

create function public.touch_app_presence()
returns table (
  connected boolean,
  friend_display_name text,
  visit_state text,
  friend_here boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_friend_id uuid;
  v_connection_id uuid;
  v_friend_name text;
  v_my_allowed boolean := false;
  v_friend_allowed boolean := false;
  v_my_state text := 'needs_consent';
  v_friend_here boolean := false;
  v_bucket bigint := floor(extract(epoch from now()) / 1800)::bigint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select friend_user_id, connection_id
  into v_friend_id, v_connection_id
  from public.friend_links
  where user_id = v_user_id;

  if not found then
    delete from public.app_presence where user_id = v_user_id;
    return query select false, null::text, 'none'::text, false;
    return;
  end if;

  select display_name into v_friend_name
  from public.friend_profiles
  where user_id = v_friend_id;

  select c.allowed,
         case when c.allowed then 'allowed' else 'declined' end
  into v_my_allowed, v_my_state
  from public.friend_visit_consents as c
  where c.user_id = v_user_id
    and c.connection_id = v_connection_id
    and c.consent_version = 1;

  if not found then
    v_my_allowed := false;
    v_my_state := 'needs_consent';
  end if;

  select c.allowed into v_friend_allowed
  from public.friend_visit_consents as c
  where c.user_id = v_friend_id
    and c.connection_id = v_connection_id
    and c.consent_version = 1;

  if not found then
    v_friend_allowed := false;
  end if;

  if not (v_my_allowed and v_friend_allowed) then
    delete from public.app_presence where user_id = v_user_id;
    return query select true, v_friend_name, v_my_state, false;
    return;
  end if;

  insert into public.app_presence (user_id, last_seen_at)
  values (v_user_id, now())
  on conflict (user_id) do update
  set last_seen_at = excluded.last_seen_at
  where public.app_presence.last_seen_at < now() - interval '20 seconds';

  select exists (
    select 1
    from public.app_presence
    where user_id = v_friend_id
      and last_seen_at > now() - interval '3 minutes'
  ) into v_friend_here;

  if v_friend_here then
    insert into public.presence_analytics_events (
      event_id, user_id, event_type, occurred_at
    ) values (
      'overlap:' || v_connection_id::text || ':' || v_bucket::text,
      least(v_user_id, v_friend_id),
      'friend_overlap',
      now()
    ) on conflict do nothing;
  end if;

  delete from public.app_presence
  where last_seen_at < now() - interval '15 minutes';

  return query select true, v_friend_name, v_my_state, v_friend_here;
end;
$$;

create function public.leave_app_presence()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  delete from public.app_presence where user_id = v_user_id;
end;
$$;

create function public.record_friend_rabbit_seen()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_friend_id uuid;
  v_connection_id uuid;
  v_bucket bigint := floor(extract(epoch from now()) / 1800)::bigint;
  v_inserted integer := 0;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select friend_user_id, connection_id
  into v_friend_id, v_connection_id
  from public.friend_links
  where user_id = v_user_id;

  if not found then return false; end if;

  if not exists (
    select 1
    from public.friend_visit_consents
    where user_id = v_user_id
      and connection_id = v_connection_id
      and consent_version = 1
      and allowed
  ) or not exists (
    select 1
    from public.friend_visit_consents
    where user_id = v_friend_id
      and connection_id = v_connection_id
      and consent_version = 1
      and allowed
  ) or not exists (
    select 1
    from public.app_presence
    where user_id = v_user_id
      and last_seen_at > now() - interval '3 minutes'
  ) or not exists (
    select 1
    from public.app_presence
    where user_id = v_friend_id
      and last_seen_at > now() - interval '3 minutes'
  ) then
    return false;
  end if;

  insert into public.presence_analytics_events (
    event_id, user_id, event_type, occurred_at
  ) values (
    'rabbit-seen:' || v_bucket::text,
    v_user_id,
    'friend_rabbit_seen',
    now()
  ) on conflict do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.set_friend_visit_allowed(boolean) from public, anon;
revoke all on function public.touch_app_presence() from public, anon;
revoke all on function public.leave_app_presence() from public, anon;
revoke all on function public.record_friend_rabbit_seen() from public, anon;

grant execute on function public.set_friend_visit_allowed(boolean) to authenticated;
grant execute on function public.touch_app_presence() to authenticated;
grant execute on function public.leave_app_presence() to authenticated;
grant execute on function public.record_friend_rabbit_seen() to authenticated;

create or replace view public.measurement_p5_kpis
with (security_invoker = true)
as
with weeks as (
  select date_trunc('week', occurred_at at time zone 'Asia/Seoul')::date as week_start
  from public.measurement_events
  union
  select date_trunc('week', occurred_at at time zone 'Asia/Seoul')::date
  from public.presence_analytics_events
)
select
  w.week_start,
  (select count(*) from public.measurement_events m
   where date_trunc('week', m.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and m.event_type = 'friend_invite_created') as invite_created,
  (select count(*) from public.measurement_events m
   where date_trunc('week', m.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and m.event_type = 'friend_invite_accepted') as friend_connected,
  (select count(*) from public.presence_analytics_events p
   where date_trunc('week', p.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and p.event_type = 'reading_presence_started') as presence_started,
  (select count(*) from public.presence_analytics_events p
   where date_trunc('week', p.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and p.event_type = 'co_reading_seen') as co_reading_seen,
  (select count(*) from public.presence_analytics_events p
   where date_trunc('week', p.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and p.event_type = 'friend_overlap') as friend_overlap_buckets,
  (select count(distinct split_part(p.event_id, ':', 2))
   from public.presence_analytics_events p
   where date_trunc('week', p.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and p.event_type = 'friend_overlap') as overlap_pairs,
  (select count(*) from public.presence_analytics_events p
   where date_trunc('week', p.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and p.event_type = 'friend_rabbit_seen') as friend_rabbit_seen,
  (select count(distinct p.user_id) from public.presence_analytics_events p
   where date_trunc('week', p.occurred_at at time zone 'Asia/Seoul')::date = w.week_start
     and p.event_type = 'friend_rabbit_seen') as rabbit_seen_users
from weeks as w;

create view public.measurement_friend_visit_snapshot
with (security_invoker = true)
as
with connections as (
  select connection_id
  from public.friend_links
  group by connection_id
  having count(*) = 2
), current_consents as (
  select c.user_id, c.connection_id, c.allowed
  from public.friend_visit_consents as c
  join public.friend_links as l
    on l.user_id = c.user_id
   and l.connection_id = c.connection_id
  where c.consent_version = 1
)
select
  (select count(*) from connections) as connected_pairs,
  (select count(*)
   from connections as x
   where (select count(*) from current_consents c
          where c.connection_id = x.connection_id and c.allowed) = 2) as mutual_allowed_pairs,
  (select count(*)
   from public.friend_links l
   where not exists (
     select 1 from current_consents c where c.user_id = l.user_id
   )) as needs_consent_users,
  (select count(*) from current_consents where not allowed) as declined_users;

revoke all on public.measurement_p5_kpis from public, anon, authenticated;
revoke all on public.measurement_friend_visit_snapshot from public, anon, authenticated;
grant select on public.measurement_p5_kpis to service_role;
grant select on public.measurement_friend_visit_snapshot to service_role;

commit;
