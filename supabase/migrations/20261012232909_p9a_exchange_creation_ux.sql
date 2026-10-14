/* P9-A creation UX: allow a room to use searched catalog metadata without
 * creating a private library book. The creator can chat immediately and may
 * link a personal book in a later, explicit flow. */

create function public.create_exchange_reading_room_from_metadata(
  p_client_id uuid,
  p_work_title text,
  p_work_author text,
  p_work_isbn13 text,
  p_work_total_pages integer,
  p_invited_connection_ids uuid[],
  p_progress_consent boolean
)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid();
  room_id uuid:=gen_random_uuid();
  existing public.exchange_reading_rooms%rowtype;
  invited_users uuid[];
  participants uuid[];
  invited_count integer;
  title_value text:=btrim(coalesce(p_work_title,''));
  author_value text:=btrim(coalesce(p_work_author,''));
  isbn_value text:=nullif(regexp_replace(coalesce(p_work_isbn13,''),'[^0-9]','','g'),'');
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_client_id is null or p_invited_connection_ids is null or not coalesce(p_progress_consent,false)
     or cardinality(p_invited_connection_ids)<1 or cardinality(p_invited_connection_ids)>3 then
    raise exception using errcode='23514',message='Invite one to three friends';
  end if;
  if char_length(title_value)<1 or char_length(title_value)>200 or title_value~'[[:cntrl:]]'
     or char_length(author_value)<1 or char_length(author_value)>160 or author_value~'[[:cntrl:]]'
     or p_work_total_pages is null or p_work_total_pages<1 or p_work_total_pages>100000
     or (isbn_value is not null and isbn_value!~'^[0-9]{13}$') then
    raise exception using errcode='23514',message='Book metadata is invalid';
  end if;
  if cardinality(p_invited_connection_ids)<>(select count(distinct item)::int from unnest(p_invited_connection_ids) item) then
    raise exception using errcode='23514',message='Duplicate invitations are not allowed';
  end if;

  select * into existing from public.exchange_reading_rooms room
    where room.creator_id=uid and room.client_id=p_client_id;
  if found then
    if existing.work_title<>title_value or existing.work_author<>author_value
       or coalesce(existing.work_isbn13,'')<>coalesce(isbn_value,'')
       or existing.work_total_pages<>p_work_total_pages then
      raise exception using errcode='PT409',message='Room retry does not match';
    end if;
    return existing.id;
  end if;

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
    room_id,uid,p_client_id,title_value,author_value,
    public.p9a_normalize_work_text(title_value),public.p9a_normalize_work_text(author_value),
    isbn_value,p_work_total_pages
  );
  insert into public.exchange_reading_members(
    room_id,user_id,invited_by,display_name_snapshot,status,invited_at,joined_at,progress_consent_at
  ) select room_id,uid,null,profile.display_name,'active',statement_timestamp(),statement_timestamp(),statement_timestamp()
    from public.friend_profiles profile where profile.user_id=uid;
  insert into public.exchange_reading_members(room_id,user_id,invited_by,display_name_snapshot,status)
    select room_id,profile.user_id,uid,profile.display_name,'invited'
    from public.friend_profiles profile where profile.user_id=any(invited_users);
  return room_id;
end $$;

create or replace function public.get_exchange_reading_room_detail(p_room_id uuid)
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
  select r.work_title,r.work_author,m.display_name_snapshot,m.user_id=uid,b.current_page,
    coalesce(b.total_pages,r.work_total_pages),
    coalesce(b.status='done' and b.current_page=b.total_pages,false),
    coalesce(b.isbn13~'^[0-9]{13}$' and viewer_book.isbn13~'^[0-9]{13}$'
      and b.isbn13=viewer_book.isbn13 and b.total_pages=viewer_book.total_pages,false)
  from public.exchange_reading_members m
  join public.exchange_reading_rooms r on r.id=m.room_id
  left join public.exchange_reading_member_books mb on mb.room_id=m.room_id and mb.user_id=m.user_id
  left join public.books b on b.id=mb.book_id and b.user_id=m.user_id
  where m.room_id=p_room_id and m.status='active' and m.progress_consent_at is not null
  order by m.joined_at,m.user_id;
end $$;

revoke all on function public.create_exchange_reading_room_from_metadata(uuid,text,text,text,integer,uuid[],boolean) from public,anon;
grant execute on function public.create_exchange_reading_room_from_metadata(uuid,text,text,text,integer,uuid[],boolean) to authenticated;

