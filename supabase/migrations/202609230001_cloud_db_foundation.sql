begin;

create table public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  title text not null,
  author text not null,
  total_pages integer not null check (total_pages > 0),
  current_page integer not null default 0,
  status text not null check (status in ('toread', 'reading', 'done')),
  isbn13 text,
  publisher text,
  published_on date,
  source_provider text,
  source_id text,
  cover_source_url text,
  last_page_log_date date,
  day_start_page integer,
  completed_at timestamptz,
  completion_reflection_text text,
  completion_reflection_created_at timestamptz,
  completion_reflection_updated_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_user_client_unique unique (user_id, client_id),
  constraint books_id_user_unique unique (id, user_id),
  constraint books_current_page_range check (
    current_page >= 0 and current_page <= total_pages
  ),
  constraint books_day_start_page_nonnegative check (
    day_start_page is null or day_start_page >= 0
  )
);

create table public.reading_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null,
  client_id text not null,
  log_date date not null,
  previous_page integer not null,
  current_page integer not null,
  delta integer not null,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint reading_logs_user_client_unique unique (user_id, client_id),
  constraint reading_logs_book_owner_fk foreign key (book_id, user_id)
    references public.books(id, user_id) on delete cascade,
  constraint reading_logs_pages_nonnegative check (
    previous_page >= 0 and current_page >= 0
  ),
  constraint reading_logs_delta_consistent check (
    delta = current_page - previous_page
  )
);

create table public.book_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null,
  client_id text not null,
  text text not null check (length(btrim(text)) > 0),
  page integer check (page is null or page >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint book_notes_user_client_unique unique (user_id, client_id),
  constraint book_notes_book_owner_fk foreign key (book_id, user_id)
    references public.books(id, user_id) on delete cascade
);

create index books_user_id_idx on public.books(user_id);
create index books_user_updated_at_idx on public.books(user_id, updated_at desc);
create index reading_logs_user_recorded_at_idx on public.reading_logs(user_id, recorded_at desc);
create index reading_logs_book_recorded_at_idx on public.reading_logs(book_id, recorded_at);
create index reading_logs_user_log_date_idx on public.reading_logs(user_id, log_date);
create index book_notes_user_id_idx on public.book_notes(user_id);
create index book_notes_book_created_at_idx on public.book_notes(book_id, created_at);

create function public.booktokki_touch_book()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.user_id := old.user_id;
  new.client_id := old.client_id;
  new.created_at := old.created_at;
  new.updated_at := now();
  new.revision := old.revision + 1;
  return new;
end;
$$;

create trigger books_touch_before_update
before update on public.books
for each row execute function public.booktokki_touch_book();

create function public.booktokki_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id := old.id;
  new.user_id := old.user_id;
  new.book_id := old.book_id;
  new.client_id := old.client_id;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

create trigger book_notes_touch_before_update
before update on public.book_notes
for each row execute function public.booktokki_touch_updated_at();

alter table public.books enable row level security;
alter table public.reading_logs enable row level security;
alter table public.book_notes enable row level security;

revoke all on table public.books from anon, authenticated;
revoke all on table public.reading_logs from anon, authenticated;
revoke all on table public.book_notes from anon, authenticated;

grant select, insert, update, delete on table public.books to authenticated;
grant select, insert, update, delete on table public.reading_logs to authenticated;
grant select, insert, update, delete on table public.book_notes to authenticated;

create policy books_select_own
on public.books for select to authenticated
using ((select auth.uid()) = user_id);

create policy books_insert_own
on public.books for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy books_update_own
on public.books for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy books_delete_own
on public.books for delete to authenticated
using ((select auth.uid()) = user_id);

create policy reading_logs_select_own
on public.reading_logs for select to authenticated
using ((select auth.uid()) = user_id);

create policy reading_logs_insert_own
on public.reading_logs for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy reading_logs_update_own
on public.reading_logs for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy reading_logs_delete_own
on public.reading_logs for delete to authenticated
using ((select auth.uid()) = user_id);

create policy book_notes_select_own
on public.book_notes for select to authenticated
using ((select auth.uid()) = user_id);

create policy book_notes_insert_own
on public.book_notes for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy book_notes_update_own
on public.book_notes for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy book_notes_delete_own
on public.book_notes for delete to authenticated
using ((select auth.uid()) = user_id);

/*
 * Atomically records a page change and updates the parent book.
 * SECURITY INVOKER is intentional: table RLS remains active, while the
 * explicit auth.uid() predicates keep ownership visible in the function.
 * The books trigger advances revision and supplies the server updated_at.
 */
create function public.record_page(
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
