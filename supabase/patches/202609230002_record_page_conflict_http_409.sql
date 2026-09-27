begin;

/*
 * Replaces SQLSTATE 40001 with PostgREST's explicit HTTP 409 code for stale
 * revisions. The function signature, transaction behavior, RLS context, and
 * grants remain unchanged.
 */
create or replace function public.record_page(
  p_book_id uuid,
  p_expected_revision bigint,
  p_log_client_id text,
  p_new_page integer,
  p_log_date date,
  p_recorded_at timestamptz
)
returns table (
  book_id uuid,
  revision bigint,
  log_created boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_book public.books%rowtype;
  v_existing_log public.reading_logs%rowtype;
  v_page integer;
  v_day_start_page integer;
  v_status text;
  v_completed_at timestamptz;
  v_revision bigint;
  v_log_created boolean := false;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;
  if p_expected_revision is null or p_log_client_id is null or btrim(p_log_client_id) = ''
     or p_new_page is null or p_log_date is null or p_recorded_at is null then
    raise exception using errcode = '22004', message = 'Missing page record input';
  end if;

  /* A retried completed operation is a no-op, keyed by the local log ID. */
  select l.* into v_existing_log
  from public.reading_logs as l
  where l.user_id = v_user_id and l.client_id = p_log_client_id;

  if found then
    select b.* into v_book
    from public.books as b
    where b.id = p_book_id and b.user_id = v_user_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'Book not found';
    end if;
    v_page := greatest(0, least(v_book.total_pages, p_new_page));
    if v_existing_log.book_id <> p_book_id
       or v_existing_log.current_page <> v_page
       or v_existing_log.log_date <> p_log_date then
      raise exception using errcode = '23505', message = 'Page log client_id already belongs to another operation';
    end if;
    return query select v_book.id, v_book.revision, true;
    return;
  end if;

  select b.* into v_book
  from public.books as b
  where b.id = p_book_id and b.user_id = v_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Book not found';
  end if;
  if v_book.revision <> p_expected_revision then
    raise sqlstate 'PT409' using message = 'Book revision conflict';
  end if;

  /* Matches buildPageLogPatch(): clamp to the valid page range. */
  v_page := greatest(0, least(v_book.total_pages, p_new_page));
  v_day_start_page := case
    when v_book.last_page_log_date is distinct from p_log_date then v_book.current_page
    when v_book.day_start_page is not null then v_book.day_start_page
    else v_book.current_page
  end;
  v_status := case
    when v_page >= v_book.total_pages then 'done'
    when v_page > 0 then 'reading'
    else 'toread'
  end;
  v_completed_at := case
    when v_status = 'done' then coalesce(v_book.completed_at, p_recorded_at)
    else null
  end;

  if v_page <> v_book.current_page then
    insert into public.reading_logs (
      user_id, book_id, client_id, log_date,
      previous_page, current_page, delta, recorded_at
    ) values (
      v_user_id, v_book.id, p_log_client_id, p_log_date,
      v_book.current_page, v_page, v_page - v_book.current_page, p_recorded_at
    );
    v_log_created := true;
  end if;

  update public.books as b
  set current_page = v_page,
      status = v_status,
      completed_at = v_completed_at,
      last_page_log_date = p_log_date,
      day_start_page = v_day_start_page
  where b.id = v_book.id
    and b.user_id = v_user_id
    and b.revision = p_expected_revision
  returning b.revision into v_revision;

  if not found then
    raise sqlstate 'PT409' using message = 'Book revision conflict';
  end if;

  return query select v_book.id, v_revision, v_log_created;
end;
$$;

revoke all on function public.record_page(uuid, bigint, text, integer, date, timestamptz) from public, anon;
grant execute on function public.record_page(uuid, bigint, text, integer, date, timestamptz) to authenticated;

commit;
