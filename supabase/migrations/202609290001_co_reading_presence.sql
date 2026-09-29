begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

/*
 * Phase 1 — Co-reading Presence foundation.
 *
 * This migration is intentionally isolated from books, reading_logs,
 * book_notes, local migration/restore, and IndexedDB. A friend can learn only
 * the display name chosen for this feature and whether the other person is
 * currently reading. No book, page, note, or presence history is exposed.
 */

create table public.friend_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_profiles_display_name_check check (
    char_length(btrim(display_name)) between 1 and 20
    and display_name !~ '[[:cntrl:]]'
  )
);

create table public.friend_invites (
  id uuid primary key default gen_random_uuid(),
  inviter_user_id uuid not null unique references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint friend_invites_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint friend_invites_expiry_check check (expires_at > created_at)
);

/* Two mirrored rows make “one friend maximum” enforceable with a primary key. */
create table public.friend_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  friend_user_id uuid not null unique references auth.users(id) on delete cascade,
  connection_id uuid not null,
  connected_at timestamptz not null default now(),
  constraint friend_links_not_self check (user_id <> friend_user_id),
  constraint friend_links_connection_user_unique unique (connection_id, user_id)
);

/* One mutable row per user: starting again replaces the current presence. */
create table public.reading_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint reading_presence_expiry_check check (expires_at > started_at)
);

/* Only the two Founder-approved, content-free measurements live here. */
create table public.presence_analytics_events (
  event_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('reading_presence_started', 'co_reading_seen')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id),
  constraint presence_analytics_event_id_length check (char_length(event_id) between 1 and 120),
  constraint presence_analytics_occurred_at_range check (
    occurred_at between (created_at - interval '5 minutes') and (created_at + interval '5 minutes')
  )
);

create index friend_links_friend_user_id_idx on public.friend_links(friend_user_id);
create index friend_links_connection_id_idx on public.friend_links(connection_id);
create index friend_invites_expires_at_idx on public.friend_invites(expires_at);
create index reading_presence_expires_at_idx on public.reading_presence(expires_at);
create index presence_analytics_user_occurred_at_idx on public.presence_analytics_events(user_id, occurred_at);
create index presence_analytics_type_occurred_at_idx on public.presence_analytics_events(event_type, occurred_at);

create function public.booktokki_touch_friend_profile()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.display_name := btrim(new.display_name);
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := new.created_at;
    return new;
  end if;
  new.user_id := old.user_id;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

create trigger friend_profiles_touch_before_write
before insert or update on public.friend_profiles
for each row execute function public.booktokki_touch_friend_profile();

revoke all on function public.booktokki_touch_friend_profile() from public, anon, authenticated;

alter table public.friend_profiles enable row level security;
alter table public.friend_invites enable row level security;
alter table public.friend_links enable row level security;
alter table public.reading_presence enable row level security;
alter table public.presence_analytics_events enable row level security;

revoke all on table public.friend_profiles from anon, authenticated;
revoke all on table public.friend_invites from anon, authenticated;
revoke all on table public.friend_links from anon, authenticated;
revoke all on table public.reading_presence from anon, authenticated;
revoke all on table public.presence_analytics_events from anon, authenticated;

/*
 * Clients may record only co_reading_seen and cannot supply created_at.
 * reading_presence_started is written exclusively by start_reading_presence().
 */
grant insert (event_id, user_id, event_type, occurred_at)
on table public.presence_analytics_events to authenticated;

create policy presence_analytics_insert_own_co_reading_seen
on public.presence_analytics_events for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and event_type = 'co_reading_seen'
);

/*
 * Cross-user connection operations need narrowly-scoped SECURITY DEFINER RPCs:
 * accepting/disconnecting must atomically write both users' mirrored rows,
 * while the underlying tables remain unavailable through the Data API.
 * Every RPC checks auth.uid(), pins search_path, and exposes no content data.
 */
create function public.set_friend_display_name(p_display_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text := btrim(p_display_name);
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if v_display_name is null or char_length(v_display_name) not between 1 and 20
     or v_display_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '23514', message = 'Invalid friend display name';
  end if;

  insert into public.friend_profiles (user_id, display_name)
  values (v_user_id, v_display_name)
  on conflict (user_id) do update set display_name = excluded.display_name;
  return v_display_name;
end;
$$;

create function public.get_friend_display_name()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  select display_name into v_display_name from public.friend_profiles where user_id = v_user_id;
  return v_display_name;
end;
$$;

create function public.create_friend_invite()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text;
  v_token_hash text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if exists (select 1 from public.friend_links where user_id = v_user_id) then
    raise sqlstate 'PT409' using message = 'Friend already connected';
  end if;
  if not exists (select 1 from public.friend_profiles where user_id = v_user_id) then
    raise exception using errcode = '23514', message = 'Friend display name required';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  delete from public.friend_invites where inviter_user_id = v_user_id;
  insert into public.friend_invites (inviter_user_id, token_hash)
  values (v_user_id, v_token_hash);
  return v_token;
end;
$$;

create function public.preview_friend_invite(p_token text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_token_hash text;
  v_display_name text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_token is null or char_length(p_token) <> 64 or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0002', message = 'Invite not found or expired';
  end if;
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  select p.display_name into v_display_name
  from public.friend_invites as i
  join public.friend_profiles as p on p.user_id = i.inviter_user_id
  where i.token_hash = v_token_hash and i.expires_at > now();
  if not found then
    raise exception using errcode = 'P0002', message = 'Invite not found or expired';
  end if;
  return v_display_name;
end;
$$;

create function public.accept_friend_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_invite public.friend_invites%rowtype;
  v_inviter_user_id uuid;
  v_token_hash text;
  v_low uuid;
  v_high uuid;
  v_connection_id uuid := gen_random_uuid();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_token is null or char_length(p_token) <> 64 or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0002', message = 'Invite not found or expired';
  end if;
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select inviter_user_id into v_inviter_user_id
  from public.friend_invites
  where token_hash = v_token_hash;

  if not found then
    raise exception using errcode = 'P0002', message = 'Invite not found or expired';
  end if;
  if v_inviter_user_id = v_user_id then
    raise exception using errcode = '23514', message = 'Cannot connect to yourself';
  end if;

  v_low := least(v_user_id, v_inviter_user_id);
  v_high := greatest(v_user_id, v_inviter_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_low::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_high::text, 0));

  select * into v_invite
  from public.friend_invites
  where token_hash = v_token_hash
  for update;

  if not found or v_invite.expires_at <= now() or v_invite.inviter_user_id <> v_inviter_user_id then
    raise exception using errcode = 'P0002', message = 'Invite not found or expired';
  end if;

  if exists (select 1 from public.friend_links where user_id in (v_user_id, v_invite.inviter_user_id)) then
    raise sqlstate 'PT409' using message = 'One of the users already has a friend';
  end if;
  if not exists (select 1 from public.friend_profiles where user_id = v_user_id)
     or not exists (select 1 from public.friend_profiles where user_id = v_invite.inviter_user_id) then
    raise exception using errcode = '23514', message = 'Both friend display names are required';
  end if;

  /* Presence belongs to the old relationship context, never the new one. */
  delete from public.reading_presence
  where user_id in (v_user_id, v_invite.inviter_user_id);

  insert into public.friend_links (user_id, friend_user_id, connection_id)
  values
    (v_user_id, v_invite.inviter_user_id, v_connection_id),
    (v_invite.inviter_user_id, v_user_id, v_connection_id);

  delete from public.friend_invites
  where inviter_user_id in (v_user_id, v_invite.inviter_user_id);

  return v_connection_id;
end;
$$;

create function public.disconnect_friend()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_link public.friend_links%rowtype;
  v_low uuid;
  v_high uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select * into v_link
  from public.friend_links
  where user_id = v_user_id;
  if not found then return false; end if;

  v_low := least(v_user_id, v_link.friend_user_id);
  v_high := greatest(v_user_id, v_link.friend_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_low::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_high::text, 0));

  select * into v_link
  from public.friend_links
  where user_id = v_user_id
  for update;
  if not found then return false; end if;

  delete from public.reading_presence
  where user_id in (v_user_id, v_link.friend_user_id);
  delete from public.friend_links where connection_id = v_link.connection_id;
  return true;
end;
$$;

create function public.start_reading_presence()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_started_at timestamptz := now();
  v_expires_at timestamptz := v_started_at + interval '60 minutes';
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if not exists (select 1 from public.friend_links where user_id = v_user_id) then
    raise exception using errcode = '23514', message = 'Friend connection required';
  end if;

  insert into public.reading_presence (user_id, started_at, expires_at, updated_at)
  values (v_user_id, v_started_at, v_expires_at, v_started_at)
  on conflict (user_id) do update
  set started_at = excluded.started_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at;

  insert into public.presence_analytics_events (event_id, user_id, event_type, occurred_at)
  values ('presence-started:' || gen_random_uuid()::text, v_user_id, 'reading_presence_started', v_started_at);

  return v_expires_at;
end;
$$;

create function public.stop_reading_presence()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted_count integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  delete from public.reading_presence where user_id = v_user_id;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

create function public.get_co_reading_presence()
returns table (
  connected boolean,
  friend_display_name text,
  current_user_reading boolean,
  friend_reading boolean,
  co_reading boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_friend_id uuid;
  v_friend_name text;
  v_current_active boolean := false;
  v_friend_active boolean := false;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select friend_user_id into v_friend_id
  from public.friend_links
  where user_id = v_user_id;

  if not found then
    return query select false, null::text, false, false, false;
    return;
  end if;

  select display_name into v_friend_name
  from public.friend_profiles
  where user_id = v_friend_id;

  select exists (
    select 1 from public.reading_presence
    where user_id = v_user_id and expires_at > now()
  ) into v_current_active;
  select exists (
    select 1 from public.reading_presence
    where user_id = v_friend_id and expires_at > now()
  ) into v_friend_active;

  return query select true, v_friend_name, v_current_active, v_friend_active,
    (v_current_active and v_friend_active);
end;
$$;

revoke all on function public.set_friend_display_name(text) from public, anon;
revoke all on function public.get_friend_display_name() from public, anon;
revoke all on function public.create_friend_invite() from public, anon;
revoke all on function public.preview_friend_invite(text) from public, anon;
revoke all on function public.accept_friend_invite(text) from public, anon;
revoke all on function public.disconnect_friend() from public, anon;
revoke all on function public.start_reading_presence() from public, anon;
revoke all on function public.stop_reading_presence() from public, anon;
revoke all on function public.get_co_reading_presence() from public, anon;

grant execute on function public.set_friend_display_name(text) to authenticated;
grant execute on function public.get_friend_display_name() to authenticated;
grant execute on function public.create_friend_invite() to authenticated;
grant execute on function public.preview_friend_invite(text) to authenticated;
grant execute on function public.accept_friend_invite(text) to authenticated;
grant execute on function public.disconnect_friend() to authenticated;
grant execute on function public.start_reading_presence() to authenticated;
grant execute on function public.stop_reading_presence() to authenticated;
grant execute on function public.get_co_reading_presence() to authenticated;

commit;
