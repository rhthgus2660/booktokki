begin;

create table public.message_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  receive_messages boolean not null default true,
  in_app_notifications boolean not null default true,
  preview_message boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.message_preferences enable row level security;
revoke all on table public.message_preferences from public,anon,authenticated,service_role;

create table public.conversation_read_cursors (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  last_read_message_id uuid not null references public.friend_messages(id) on delete cascade,
  last_read_created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key(user_id,connection_id)
);

create index conversation_read_cursors_user_updated_idx
  on public.conversation_read_cursors(user_id,updated_at desc);

alter table public.conversation_read_cursors enable row level security;
revoke all on table public.conversation_read_cursors from public,anon,authenticated,service_role;

create function public.get_my_message_preferences()
returns table(receive_messages boolean,in_app_notifications boolean,preview_message boolean)
language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query
  select coalesce(p.receive_messages,true),coalesce(p.in_app_notifications,true),coalesce(p.preview_message,false)
  from (select 1) seed
  left join public.message_preferences p on p.user_id=uid;
end $$;

create function public.update_my_message_preferences(
  p_receive_messages boolean,
  p_in_app_notifications boolean,
  p_preview_message boolean
)
returns table(receive_messages boolean,in_app_notifications boolean,preview_message boolean)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_receive_messages is null or p_in_app_notifications is null or p_preview_message is null then
    raise exception using errcode='22004',message='Message preferences are incomplete';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text,0));
  insert into public.message_preferences(user_id,receive_messages,in_app_notifications,preview_message,updated_at)
  values(uid,p_receive_messages,p_in_app_notifications,p_preview_message,statement_timestamp())
  on conflict(user_id) do update set
    receive_messages=excluded.receive_messages,
    in_app_notifications=excluded.in_app_notifications,
    preview_message=excluded.preview_message,
    updated_at=excluded.updated_at;
  return query select p_receive_messages,p_in_app_notifications,p_preview_message;
end $$;

drop function public.list_friend_conversations();
create function public.list_friend_conversations()
returns table(
  connection_id uuid,
  friend_display_name text,
  friend_intro text,
  last_message text,
  last_message_at timestamptz,
  last_message_is_mine boolean,
  can_send boolean,
  unread_count bigint
)
language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query
  select conversations.connection_id,
    case when last_message.sender_id=uid then last_message.recipient_display_name else last_message.sender_display_name end,
    null::text,last_message.body,last_message.created_at,last_message.sender_id=uid,
    exists (
      select 1 from public.friend_links mine
      join public.friend_links mirror on mirror.user_id=mine.friend_user_id
        and mirror.friend_user_id=mine.user_id and mirror.connection_id=mine.connection_id
      where mine.user_id=uid and mine.connection_id=conversations.connection_id
        and not exists (
          select 1 from public.user_blocks b
          where (b.blocker_id=mine.user_id and b.blocked_id=mine.friend_user_id)
             or (b.blocker_id=mine.friend_user_id and b.blocked_id=mine.user_id)
        )
    ),
    (
      select count(*) from public.friend_messages unread
      left join public.conversation_read_cursors cursor
        on cursor.user_id=uid and cursor.connection_id=unread.connection_id
      where unread.connection_id=conversations.connection_id
        and unread.recipient_id=uid
        and (cursor.user_id is null or (unread.created_at,unread.id)>(cursor.last_read_created_at,cursor.last_read_message_id))
    )::bigint
  from (
    select distinct m.connection_id from public.friend_messages m
    where m.sender_id=uid or m.recipient_id=uid
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

create function public.get_message_inbox_state()
returns table(
  total_unread bigint,
  latest_message_id uuid,
  latest_connection_id uuid,
  latest_sender_display_name text,
  latest_body text,
  latest_created_at timestamptz,
  receive_messages boolean,
  in_app_notifications boolean,
  preview_message boolean
)
language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  return query
  with unread as (
    select m.id,m.connection_id,m.sender_display_name,m.body,m.created_at
    from public.friend_messages m
    left join public.conversation_read_cursors cursor
      on cursor.user_id=uid and cursor.connection_id=m.connection_id
    where m.recipient_id=uid
      and (cursor.user_id is null or (m.created_at,m.id)>(cursor.last_read_created_at,cursor.last_read_message_id))
  ), latest as (
    select u.* from unread u order by u.created_at desc,u.id desc limit 1
  )
  select (select count(*) from unread)::bigint,
    latest.id,latest.connection_id,latest.sender_display_name,latest.body,latest.created_at,
    coalesce(pref.receive_messages,true),coalesce(pref.in_app_notifications,true),coalesce(pref.preview_message,false)
  from (select 1) seed
  left join latest on true
  left join public.message_preferences pref on pref.user_id=uid;
end $$;

create function public.mark_friend_conversation_read(p_connection_id uuid,p_through_message_id uuid)
returns table(connection_id uuid,last_read_message_id uuid,last_read_created_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); target public.friend_messages%rowtype;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_connection_id is null or p_through_message_id is null then
    raise exception using errcode='22004',message='Read cursor request is incomplete';
  end if;
  select m.* into target from public.friend_messages m
  where m.id=p_through_message_id and m.connection_id=p_connection_id and m.recipient_id=uid;
  if not found then raise exception using errcode='42501',message='Conversation not available'; end if;
  insert into public.conversation_read_cursors(
    user_id,connection_id,last_read_message_id,last_read_created_at,updated_at
  ) values(uid,p_connection_id,target.id,target.created_at,statement_timestamp())
  on conflict on constraint conversation_read_cursors_pkey do update set
    last_read_message_id=excluded.last_read_message_id,
    last_read_created_at=excluded.last_read_created_at,
    updated_at=excluded.updated_at
  where (conversation_read_cursors.last_read_created_at,conversation_read_cursors.last_read_message_id)
    <(excluded.last_read_created_at,excluded.last_read_message_id);
  return query
  select cursor.connection_id,cursor.last_read_message_id,cursor.last_read_created_at
  from public.conversation_read_cursors cursor
  where cursor.user_id=uid and cursor.connection_id=p_connection_id;
end $$;

create or replace function public.send_friend_message(p_connection_id uuid,p_client_id uuid,p_body text)
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

  select * into existing from public.friend_messages m where m.sender_id=uid and m.client_id=p_client_id;
  if found then
    if existing.connection_id<>p_connection_id or existing.body<>message_body then
      raise sqlstate 'PT409' using message='Message request conflicts with an existing request';
    end if;
    return query select existing.id,existing.body,existing.created_at,true,true;
    return;
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
  ) or not coalesce((
    select p.receive_messages from public.message_preferences p where p.user_id=fid
  ),true) then
    raise exception using errcode='42501',message='Conversation not available';
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

revoke all on function public.get_my_message_preferences(),public.update_my_message_preferences(boolean,boolean,boolean),
  public.list_friend_conversations(),public.get_message_inbox_state(),public.mark_friend_conversation_read(uuid,uuid),
  public.send_friend_message(uuid,uuid,text) from public,anon;
grant execute on function public.get_my_message_preferences(),public.update_my_message_preferences(boolean,boolean,boolean),
  public.list_friend_conversations(),public.get_message_inbox_state(),public.mark_friend_conversation_read(uuid,uuid),
  public.send_friend_message(uuid,uuid,text) to authenticated;

commit;
