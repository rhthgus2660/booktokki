begin;

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  constraint feedback_message_length_check check (
    char_length(regexp_replace(message, '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 2000
  )
);

create index feedback_user_created_at_idx
on public.feedback(user_id, created_at desc);

alter table public.feedback enable row level security;

revoke all on table public.feedback from anon, authenticated;
grant insert on table public.feedback to authenticated;

create policy feedback_insert_own
on public.feedback for insert to authenticated
with check ((select auth.uid()) = feedback.user_id);

commit;
