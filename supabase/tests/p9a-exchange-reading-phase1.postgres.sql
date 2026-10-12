\set ON_ERROR_STOP on

create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable
as $$select coalesce(
  nullif(current_setting('request.jwt.claim.sub',true),''),
  nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
)::uuid$$;

create table public.friend_profiles(
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null
);
create table public.friend_links(
  user_id uuid not null references auth.users(id),
  friend_user_id uuid not null references auth.users(id),
  connection_id uuid not null,
  connected_at timestamptz default now(),
  primary key(user_id,friend_user_id),
  unique(connection_id,user_id)
);
create table public.user_blocks(
  blocker_id uuid not null references auth.users(id),
  blocked_id uuid not null references auth.users(id),
  source_connection_id uuid not null,
  blocked_display_name text not null,
  created_at timestamptz default now(),
  primary key(blocker_id,blocked_id)
);
create table public.social_reports(
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  detail text,
  reported_display_name text not null,
  reported_intro text,
  review_status text not null default 'received',
  reviewed_at timestamptz,
  created_at timestamptz default now()
);
create table public.conversation_report_evidence(
  report_id uuid primary key references public.social_reports(id) on delete cascade,
  message_body text
);
create table public.books(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  title text not null,
  author text not null,
  total_pages integer not null,
  current_page integer not null default 0,
  status text not null default 'toread',
  isbn13 text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(id,user_id),unique(user_id,client_id)
);
create table public.book_notes(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid not null,
  client_id text not null,
  text text not null,
  page integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,client_id),
  foreign key(book_id,user_id) references public.books(id,user_id) on delete cascade
);

revoke all on table public.friend_profiles,public.friend_links,public.user_blocks,
  public.social_reports,public.books,public.book_notes from anon,authenticated;
grant select,insert,update,delete on public.books,public.book_notes to authenticated;

\ir ../migrations/20261011113246_p9a_exchange_reading_phase1.sql

insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004'),
  ('00000000-0000-4000-8000-000000000005');
insert into public.friend_profiles(user_id,display_name)
select id,'User-'||right(id::text,2) from auth.users;
insert into public.friend_links(user_id,friend_user_id,connection_id) values
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000103'),
  ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103'),
  ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000104'),
  ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000104');
insert into public.books(user_id,client_id,title,author,total_pages,isbn13)
select id,'book-'||right(id::text,2),'Shared Work','Writer',300,'isbn-'||right(id::text,2)
from auth.users;
