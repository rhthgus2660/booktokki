begin;

create table public.analytics_events (
  event_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null,
  event_type text not null check (event_type in ('book_added', 'reading_record_saved')),
  occurred_at timestamptz not null,
  with_note boolean,
  constraint analytics_events_payload_check check (
    (event_type = 'book_added' and with_note is null)
    or
    (event_type = 'reading_record_saved' and with_note is not null)
  )
);

create index analytics_events_user_occurred_at_idx
on public.analytics_events(user_id, occurred_at);

create index analytics_events_type_occurred_at_idx
on public.analytics_events(event_type, occurred_at);

alter table public.analytics_events enable row level security;

revoke all on table public.analytics_events from anon, authenticated;
grant insert on table public.analytics_events to authenticated;

create policy analytics_events_insert_own
on public.analytics_events for insert to authenticated
with check (
  (select auth.uid()) = analytics_events.user_id
  and exists (
    select 1 from public.books as b
    where b.id = analytics_events.book_id
      and b.user_id = (select auth.uid())
  )
);

commit;
