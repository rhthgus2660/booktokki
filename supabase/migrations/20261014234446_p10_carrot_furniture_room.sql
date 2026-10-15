begin;

create table public.p10_carrot_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.p10_carrot_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_key text not null check (char_length(activity_key) between 1 and 180),
  entry_kind text not null check (entry_kind in ('daily_page','daily_note','first_completion','purchase')),
  amount integer not null check (amount <> 0),
  source_id uuid,
  reward_day date,
  created_at timestamptz not null default now(),
  unique (user_id,activity_key)
);
create index p10_carrot_ledger_user_created_idx on public.p10_carrot_ledger(user_id,created_at desc);

/* Claims are separate from financial ledger entries so pre-P10 activity can
 * block retroactive rewards without inventing a balance transaction. */
create table public.p10_reward_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_key text not null check (char_length(activity_key) between 1 and 180),
  claimed_at timestamptz not null default now(),
  primary key (user_id,activity_key)
);
insert into public.p10_reward_claims(user_id,activity_key,claimed_at)
select l.user_id,'daily-page:'||l.log_date::text,min(l.created_at)
from public.reading_logs l where l.delta>0 group by l.user_id,l.log_date
on conflict do nothing;
insert into public.p10_reward_claims(user_id,activity_key,claimed_at)
select n.user_id,'daily-note:'||((n.created_at at time zone 'Asia/Seoul')::date)::text,min(n.created_at)
from public.book_notes n group by n.user_id,(n.created_at at time zone 'Asia/Seoul')::date
on conflict do nothing;
insert into public.p10_reward_claims(user_id,activity_key,claimed_at)
select b.user_id,'first-completion:'||b.id::text,
  coalesce(b.completed_at,min(l.recorded_at),b.updated_at)
from public.books b left join public.reading_logs l on l.book_id=b.id and l.user_id=b.user_id and l.current_page>=b.total_pages
where b.status='done' or b.completed_at is not null or l.id is not null
group by b.id,b.user_id,b.completed_at,b.updated_at
on conflict do nothing;

create table public.p10_furniture_catalog (
  id text primary key check (id in ('A','B','C')),
  display_name text not null,
  price integer not null check (price > 0),
  required_reading_days integer not null check (required_reading_days >= 0),
  asset_id text not null unique,
  sort_order smallint not null unique
);
insert into public.p10_furniture_catalog(id,display_name,price,required_reading_days,asset_id,sort_order) values
  ('A','작은 화분',5,0,'F01',1),
  ('B','플로어 램프',10,3,'F04',2),
  ('C','흔들의자',20,7,'F08',3);

create table public.p10_furniture_ownership (
  user_id uuid not null references auth.users(id) on delete cascade,
  furniture_id text not null references public.p10_furniture_catalog(id),
  purchase_client_id uuid not null,
  purchased_at timestamptz not null default now(),
  primary key (user_id,furniture_id),
  unique (user_id,purchase_client_id)
);

create table public.p10_room_placements (
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id text not null check (slot_id in ('slot_1','slot_2','slot_3')),
  furniture_id text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id,slot_id),
  unique (user_id,furniture_id),
  foreign key (user_id,furniture_id)
    references public.p10_furniture_ownership(user_id,furniture_id) on delete cascade
);

alter table public.p10_carrot_accounts enable row level security;
alter table public.p10_carrot_ledger enable row level security;
alter table public.p10_reward_claims enable row level security;
alter table public.p10_furniture_catalog enable row level security;
alter table public.p10_furniture_ownership enable row level security;
alter table public.p10_room_placements enable row level security;

revoke all on table public.p10_carrot_accounts from public,anon,authenticated,service_role;
revoke all on table public.p10_carrot_ledger from public,anon,authenticated,service_role;
revoke all on table public.p10_reward_claims from public,anon,authenticated,service_role;
revoke all on table public.p10_furniture_catalog from public,anon,authenticated,service_role;
revoke all on table public.p10_furniture_ownership from public,anon,authenticated,service_role;
revoke all on table public.p10_room_placements from public,anon,authenticated,service_role;
grant select on table public.p10_carrot_accounts,public.p10_carrot_ledger,
  public.p10_reward_claims,public.p10_furniture_catalog,public.p10_furniture_ownership,public.p10_room_placements to service_role;

create function public.p10_award_carrots(
  p_user_id uuid,p_activity_key text,p_entry_kind text,p_amount integer,
  p_source_id uuid default null,p_reward_day date default null
)
returns boolean language plpgsql security definer set search_path='' as $$
declare inserted_count bigint;
begin
  if p_user_id is null or p_amount <= 0 then return false; end if;
  insert into public.p10_reward_claims(user_id,activity_key) values(p_user_id,p_activity_key)
  on conflict(user_id,activity_key) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count=1 then
    insert into public.p10_carrot_accounts(user_id) values(p_user_id) on conflict(user_id) do nothing;
    insert into public.p10_carrot_ledger(user_id,activity_key,entry_kind,amount,source_id,reward_day)
    values(p_user_id,p_activity_key,p_entry_kind,p_amount,p_source_id,p_reward_day);
    update public.p10_carrot_accounts set balance=balance+p_amount,updated_at=now() where user_id=p_user_id;
  end if;
  return inserted_count=1;
end $$;

create function public.p10_reward_page_progress()
returns trigger language plpgsql security definer set search_path='' as $$
declare reward_date date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
begin
  if new.delta > 0 and current_setting('booktokki.reward_write_kind',true)='record_page' then
    perform public.p10_award_carrots(new.user_id,'daily-page:'||reward_date,'daily_page',1,new.id,reward_date);
  end if;
  return new;
end $$;
create trigger reading_logs_p10_reward_after_insert after insert on public.reading_logs
for each row execute function public.p10_reward_page_progress();

create function public.p10_reward_book_note()
returns trigger language plpgsql security definer set search_path='' as $$
declare reward_date date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
begin
  if current_setting('booktokki.reward_write_kind',true)='book_note' then
    perform public.p10_award_carrots(new.user_id,'daily-note:'||reward_date,'daily_note',3,new.id,reward_date);
  end if;
  return new;
end $$;
create trigger book_notes_p10_reward_after_insert after insert on public.book_notes
for each row execute function public.p10_reward_book_note();

create function public.p10_reward_first_completion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if current_setting('booktokki.reward_write_kind',true)='record_page'
     and new.status='done' and old.status is distinct from 'done' then
    perform public.p10_award_carrots(new.user_id,'first-completion:'||new.id::text,'first_completion',10,new.id,null);
  end if;
  return new;
end $$;
create trigger books_p10_completion_after_update after update on public.books
for each row execute function public.p10_reward_first_completion();

/* Existing signature and behavior are preserved; the transaction-local marker
 * lets reward triggers distinguish the established record_page path from
 * imports, participation baselines, and direct correction writes. */
create or replace function public.record_page(
  p_book_id uuid,p_expected_revision bigint,p_log_client_id text,p_new_page integer,
  p_log_date date,p_recorded_at timestamptz
)
returns table(book_id uuid,revision bigint,log_created boolean)
language plpgsql security invoker set search_path='' as $$
declare
  v_user_id uuid:=auth.uid(); v_book public.books%rowtype; v_existing_log public.reading_logs%rowtype;
  v_page integer; v_day_start_page integer; v_status text; v_completed_at timestamptz;
  v_revision bigint; v_log_created boolean:=false;
begin
  if v_user_id is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_expected_revision is null or p_log_client_id is null or btrim(p_log_client_id)=''
     or p_new_page is null or p_log_date is null or p_recorded_at is null then
    raise exception using errcode='22004',message='Missing page record input'; end if;
  select l.* into v_existing_log from public.reading_logs l
    where l.user_id=v_user_id and l.client_id=p_log_client_id;
  if found then
    select b.* into v_book from public.books b where b.id=p_book_id and b.user_id=v_user_id;
    if not found then raise exception using errcode='P0002',message='Book not found'; end if;
    v_page:=greatest(0,least(v_book.total_pages,p_new_page));
    if v_existing_log.book_id<>p_book_id or v_existing_log.current_page<>v_page or v_existing_log.log_date<>p_log_date then
      raise exception using errcode='23505',message='Page log client_id already belongs to another operation'; end if;
    return query select v_book.id,v_book.revision,true; return;
  end if;
  select b.* into v_book from public.books b where b.id=p_book_id and b.user_id=v_user_id for update;
  if not found then raise exception using errcode='P0002',message='Book not found'; end if;
  if v_book.revision<>p_expected_revision then raise sqlstate 'PT409' using message='Book revision conflict'; end if;
  v_page:=greatest(0,least(v_book.total_pages,p_new_page));
  v_day_start_page:=case when v_book.last_page_log_date is distinct from p_log_date then v_book.current_page
    when v_book.day_start_page is not null then v_book.day_start_page else v_book.current_page end;
  v_status:=case when v_page>=v_book.total_pages then 'done' when v_page>0 then 'reading' else 'toread' end;
  v_completed_at:=case when v_status='done' then coalesce(v_book.completed_at,p_recorded_at) else null end;
  perform set_config('booktokki.reward_write_kind','record_page',true);
  if v_page<>v_book.current_page then
    insert into public.reading_logs(user_id,book_id,client_id,log_date,previous_page,current_page,delta,recorded_at)
    values(v_user_id,v_book.id,p_log_client_id,p_log_date,v_book.current_page,v_page,v_page-v_book.current_page,p_recorded_at);
    v_log_created:=true;
  end if;
  update public.books b set current_page=v_page,status=v_status,completed_at=v_completed_at,
    last_page_log_date=p_log_date,day_start_page=v_day_start_page
  where b.id=v_book.id and b.user_id=v_user_id and b.revision=p_expected_revision
  returning b.revision into v_revision;
  if not found then raise sqlstate 'PT409' using message='Book revision conflict'; end if;
  return query select v_book.id,v_revision,v_log_created;
end $$;

create function public.create_book_note_with_reward(
  p_book_id uuid,p_client_id text,p_text text,p_page integer,p_created_at timestamptz
)
returns setof public.book_notes language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); existing public.book_notes%rowtype; inserted public.book_notes%rowtype;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_client_id is null or btrim(p_client_id)='' or p_text is null or btrim(p_text)=''
     or p_created_at is null or (p_page is not null and p_page<0) then
    raise exception using errcode='23514',message='Book note is invalid'; end if;
  if not exists(select 1 from public.books b where b.id=p_book_id and b.user_id=uid) then
    raise exception using errcode='42501',message='Book unavailable'; end if;
  select * into existing from public.book_notes n where n.user_id=uid and n.client_id=p_client_id;
  if found then
    if existing.book_id<>p_book_id or existing.text<>p_text or existing.page is distinct from p_page then
      raise exception using errcode='23505',message='Book note client_id already belongs to another operation'; end if;
    return next existing; return;
  end if;
  perform set_config('booktokki.reward_write_kind','book_note',true);
  insert into public.book_notes(user_id,book_id,client_id,text,page,created_at,updated_at)
    values(uid,p_book_id,p_client_id,p_text,p_page,p_created_at,p_created_at) returning * into inserted;
  return next inserted;
end $$;

create function public.get_p10_room_state()
returns table(
  furniture_id text,display_name text,price integer,required_reading_days integer,asset_id text,
  balance integer,reading_days integer,owned boolean,slot_id text
) language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); days integer;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  insert into public.p10_carrot_accounts(user_id) values(uid) on conflict(user_id) do nothing;
  select count(*)::integer into days from public.p10_carrot_ledger l where l.user_id=uid and l.entry_kind='daily_page';
  return query select c.id,c.display_name,c.price,c.required_reading_days,c.asset_id,a.balance,days,
    o.user_id is not null,p.slot_id
  from public.p10_furniture_catalog c
  cross join public.p10_carrot_accounts a
  left join public.p10_furniture_ownership o on o.user_id=uid and o.furniture_id=c.id
  left join public.p10_room_placements p on p.user_id=uid and p.furniture_id=c.id
  where a.user_id=uid order by c.sort_order;
end $$;

create function public.purchase_p10_furniture(p_furniture_id text,p_client_id uuid)
returns table(furniture_id text,balance integer,owned boolean)
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); item public.p10_furniture_catalog%rowtype; account public.p10_carrot_accounts%rowtype; days integer;
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_client_id is null then raise exception using errcode='22004',message='Purchase client id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('p10-shop:'||uid::text,0));
  select * into item from public.p10_furniture_catalog c where c.id=p_furniture_id;
  if not found then raise exception using errcode='P0002',message='Furniture unavailable'; end if;
  insert into public.p10_carrot_accounts(user_id) values(uid) on conflict(user_id) do nothing;
  select * into account from public.p10_carrot_accounts a where a.user_id=uid for update;
  if exists(select 1 from public.p10_furniture_ownership o where o.user_id=uid and o.furniture_id=item.id) then
    return query select item.id,account.balance,true; return;
  end if;
  select count(*)::integer into days from public.p10_carrot_ledger l where l.user_id=uid and l.entry_kind='daily_page';
  if days<item.required_reading_days then raise exception using errcode='42501',message='Furniture is locked'; end if;
  if account.balance<item.price then raise exception using errcode='23514',message='Not enough carrots'; end if;
  insert into public.p10_furniture_ownership(user_id,furniture_id,purchase_client_id) values(uid,item.id,p_client_id);
  insert into public.p10_carrot_ledger(user_id,activity_key,entry_kind,amount,source_id)
    values(uid,'purchase:'||item.id,'purchase',-item.price,null);
  update public.p10_carrot_accounts
    set balance=public.p10_carrot_accounts.balance-item.price,updated_at=now()
    where user_id=uid returning * into account;
  return query select item.id,account.balance,true;
end $$;

create function public.place_p10_furniture(p_slot_id text,p_furniture_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_slot_id not in ('slot_1','slot_2','slot_3') then raise exception using errcode='23514',message='Invalid room slot'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('p10-room:'||uid::text,0));
  delete from public.p10_room_placements where user_id=uid and slot_id=p_slot_id;
  if p_furniture_id is null then return true; end if;
  if not exists(select 1 from public.p10_furniture_ownership o where o.user_id=uid and o.furniture_id=p_furniture_id) then
    raise exception using errcode='42501',message='Furniture is not owned'; end if;
  delete from public.p10_room_placements where user_id=uid and furniture_id=p_furniture_id;
  insert into public.p10_room_placements(user_id,slot_id,furniture_id) values(uid,p_slot_id,p_furniture_id);
  return true;
end $$;

revoke all on function public.p10_award_carrots(uuid,text,text,integer,uuid,date) from public,anon,authenticated,service_role;
revoke all on function public.create_book_note_with_reward(uuid,text,text,integer,timestamptz) from public,anon;
revoke all on function public.get_p10_room_state() from public,anon;
revoke all on function public.purchase_p10_furniture(text,uuid) from public,anon;
revoke all on function public.place_p10_furniture(text,text) from public,anon;
grant execute on function public.create_book_note_with_reward(uuid,text,text,integer,timestamptz) to authenticated;
grant execute on function public.get_p10_room_state() to authenticated;
grant execute on function public.purchase_p10_furniture(text,uuid) to authenticated;
grant execute on function public.place_p10_furniture(text,text) to authenticated;

commit;
