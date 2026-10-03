begin;

/* PR1-B: keep legacy 0/1 friend wrappers snapshot-consistent. */
create or replace function public.disconnect_friend()
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*)::int, (array_agg(fl.connection_id order by fl.connected_at,fl.connection_id))[1]
  into n,cid from public.friend_links fl where fl.user_id=auth.uid();
  if n=0 then return false; elsif n>1 then raise exception using errcode='PT409', message='Multiple friends require a connection id'; end if;
  return public.disconnect_friend_connection(cid);
end; $$;

create or replace function public.set_friend_visit_allowed(p_allowed boolean)
returns text language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*)::int, (array_agg(fl.connection_id order by fl.connected_at,fl.connection_id))[1]
  into n,cid from public.friend_links fl where fl.user_id=auth.uid();
  if n=0 then raise exception using errcode='23514', message='Friend connection required'; elsif n>1 then raise exception using errcode='PT409', message='Multiple friends require a connection id'; end if;
  return public.set_friend_connection_visit(cid,p_allowed);
end; $$;

create or replace function public.touch_app_presence()
returns table(connected boolean,friend_display_name text,visit_state text,friend_here boolean)
language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid; nm text; state text;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*)::int, (array_agg(fl.connection_id order by fl.connected_at,fl.connection_id))[1]
  into n,cid from public.friend_links fl where fl.user_id=auth.uid();
  if n>1 then return query select true,null::text,'none'::text,false; return; end if;
  if n=0 then return query select false,null::text,'none'::text,false; return; end if;
  select g.friend_display_name,g.my_visit_state into nm,state
  from public.get_friend_connections() g where g.connection_id=cid;
  if state='undecided' then state:='needs_consent'; end if;
  return query select true,nm,state,exists(select 1 from public.touch_friend_presence() v where v.connection_id=cid);
end; $$;

create or replace function public.record_friend_rabbit_seen()
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; cid uuid;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*)::int, (array_agg(fl.connection_id order by fl.connected_at,fl.connection_id))[1]
  into n,cid from public.friend_links fl where fl.user_id=auth.uid();
  if n<>1 then return false; end if;
  return public.record_friend_rabbit_seen_v2(cid);
end; $$;

create or replace function public.get_co_reading_presence()
returns table(connected boolean,friend_display_name text,current_user_reading boolean,friend_reading boolean,co_reading boolean)
language plpgsql stable security definer set search_path='' as $$
declare n integer; cid uuid; nm text;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  select count(*)::int, (array_agg(fl.connection_id order by fl.connected_at,fl.connection_id))[1]
  into n,cid from public.friend_links fl where fl.user_id=auth.uid();
  if n=0 then return query select false,null::text,false,false,false; return; end if;
  if n>1 then return query select true,null::text,false,false,false; return; end if;
  select g.friend_display_name into nm from public.get_friend_connections() g where g.connection_id=cid;
  return query select true,nm,false,false,false;
end; $$;

/* A disconnect between ownership validation and consent write stays opaque. */
create or replace function public.set_friend_connection_visit(p_connection_id uuid, p_allowed boolean)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501', message='Authentication required'; end if;
  if p_connection_id is null or p_allowed is null then raise exception using errcode='23514', message='Visit consent decision required'; end if;
  if not exists (select 1 from public.friend_links where connection_id=p_connection_id and user_id=auth.uid()) then
    raise exception using errcode='42501', message='Connection not available';
  end if;
  begin
    insert into public.friend_visit_consents(user_id,connection_id,allowed,consent_version,decided_at)
    values(auth.uid(),p_connection_id,p_allowed,1,now())
    on conflict(user_id,connection_id) do update set allowed=excluded.allowed,consent_version=excluded.consent_version,decided_at=excluded.decided_at;
  exception when foreign_key_violation then
    raise exception using errcode='42501', message='Connection not available';
  end;
  if not p_allowed and not exists (
    select 1 from public.friend_links l
    join public.friend_visit_consents mine on mine.user_id=l.user_id and mine.connection_id=l.connection_id and mine.allowed and mine.consent_version=1
    join public.friend_visit_consents theirs on theirs.user_id=l.friend_user_id and theirs.connection_id=l.connection_id and theirs.allowed and theirs.consent_version=1
    where l.user_id=auth.uid() and l.connection_id<>p_connection_id
  ) then delete from public.app_presence where user_id=auth.uid(); end if;
  return case when p_allowed then 'allowed' else 'declined' end;
end;
$$;

revoke all on function public.disconnect_friend() from public,anon;
revoke all on function public.set_friend_visit_allowed(boolean) from public,anon;
revoke all on function public.touch_app_presence() from public,anon;
revoke all on function public.record_friend_rabbit_seen() from public,anon;
revoke all on function public.get_co_reading_presence() from public,anon;
revoke all on function public.set_friend_connection_visit(uuid,boolean) from public,anon;
grant execute on function public.disconnect_friend() to authenticated;
grant execute on function public.set_friend_visit_allowed(boolean) to authenticated;
grant execute on function public.touch_app_presence() to authenticated;
grant execute on function public.record_friend_rabbit_seen() to authenticated;
grant execute on function public.get_co_reading_presence() to authenticated;
grant execute on function public.set_friend_connection_visit(uuid,boolean) to authenticated;

commit;
