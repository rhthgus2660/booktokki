begin;

create table public.p6_reaction_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid references public.books(id) on delete set null,
  reaction_kind text not null check (reaction_kind in ('completion','first_positive_page','first_book','return')),
  source_key text not null check (char_length(source_key) between 1 and 180),
  source_occurred_at timestamptz not null,
  priority smallint not null check (priority between 1 and 4),
  claim_token uuid,
  claimed_until timestamptz,
  displayed_at timestamptz,
  completed_at timestamptz,
  resolved_at timestamptz,
  resolution text check (resolution is null or resolution in ('policy_suppressed','stale')),
  created_at timestamptz not null default now(),
  unique (user_id,source_key)
);
create index p6_reaction_candidates_claim_idx
  on public.p6_reaction_candidates(user_id,resolved_at,displayed_at,priority desc,source_occurred_at,id);
alter table public.p6_reaction_candidates enable row level security;
revoke all on table public.p6_reaction_candidates from public,anon,authenticated,service_role;
grant select on table public.p6_reaction_candidates to service_role;

create table public.p6_character_events (
  event_id text primary key check (char_length(event_id) between 1 and 120),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('app_session_started','positive_page_saved','rabbit_tapped','reaction_cta_clicked')),
  reaction_kind text check (reaction_kind is null or reaction_kind in ('completion','first_positive_page','first_book','return','contextual')),
  cta_type text check (cta_type is null or cta_type in ('book_detail','add_book','library')),
  session_id text check (session_id is null or char_length(session_id) between 1 and 120),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index p6_character_events_user_occurred_idx on public.p6_character_events(user_id,occurred_at);
create index p6_character_events_session_idx on public.p6_character_events(user_id,session_id,occurred_at) where session_id is not null;
alter table public.p6_character_events enable row level security;
revoke all on table public.p6_character_events from public,anon,authenticated,service_role;
grant select on table public.p6_character_events to service_role;

create function public.booktokki_p6_return_gap_days()
returns integer language sql immutable security definer set search_path=''
as $$ select 3 $$;
revoke all on function public.booktokki_p6_return_gap_days() from public,anon,authenticated,service_role;

create function public.booktokki_queue_first_book_reaction()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if (select count(*) from public.books where user_id=new.user_id)=1 then
    insert into public.p6_reaction_candidates(user_id,book_id,reaction_kind,source_key,source_occurred_at,priority)
    values(new.user_id,new.id,'first_book','account:first_book',new.created_at,2)
    on conflict(user_id,source_key) do nothing;
  end if;
  return new;
end $$;
create trigger books_p6_first_book_after_insert after insert on public.books
for each row execute function public.booktokki_queue_first_book_reaction();

create function public.booktokki_queue_positive_reactions()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_previous timestamptz;
begin
  if new.delta<=0 then return new; end if;
  select max(recorded_at) into v_previous from public.reading_logs
  where user_id=new.user_id and delta>0 and id<>new.id;
  if v_previous is null then
    insert into public.p6_reaction_candidates(user_id,book_id,reaction_kind,source_key,source_occurred_at,priority)
    values(new.user_id,new.book_id,'first_positive_page','account:first_positive_page',new.recorded_at,3)
    on conflict(user_id,source_key) do nothing;
  elsif new.recorded_at>=v_previous+make_interval(days=>public.booktokki_p6_return_gap_days()) then
    insert into public.p6_reaction_candidates(user_id,book_id,reaction_kind,source_key,source_occurred_at,priority)
    values(new.user_id,new.book_id,'return','return:log:'||new.client_id,new.recorded_at,1)
    on conflict(user_id,source_key) do nothing;
  end if;
  return new;
end $$;
create trigger reading_logs_p6_after_insert after insert on public.reading_logs
for each row execute function public.booktokki_queue_positive_reactions();

create function public.booktokki_queue_completion_reaction()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.status='done' and old.status is distinct from 'done' then
    insert into public.p6_reaction_candidates(user_id,book_id,reaction_kind,source_key,source_occurred_at,priority)
    values(new.user_id,new.id,'completion','completion:book:'||new.id::text||':revision:'||new.revision::text,coalesce(new.completed_at,new.updated_at),4)
    on conflict(user_id,source_key) do nothing;
  end if;
  return new;
end $$;
create trigger books_p6_completion_after_update after update on public.books
for each row execute function public.booktokki_queue_completion_reaction();

create function public.claim_p6_reaction()
returns table(reaction_id uuid,reaction_kind text,book_client_id text,source_occurred_at timestamptz,claim_token uuid)
language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_id uuid; v_token uuid:=gen_random_uuid();
begin
  if v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
  update public.p6_reaction_candidates c
  set resolved_at=now(),resolution='stale',claim_token=null,claimed_until=null
  where c.user_id=v_user and c.resolved_at is null and c.displayed_at is null
    and c.source_occurred_at<now()-interval '24 hours';
  select c.id into v_id from public.p6_reaction_candidates c
  where c.user_id=v_user and c.resolved_at is null and c.displayed_at is null
    and (c.claimed_until is null or c.claimed_until<now())
  order by c.priority desc,c.source_occurred_at,c.id
  for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.p6_reaction_candidates c set claim_token=v_token,claimed_until=now()+interval '2 minutes'
  where c.id=v_id and c.user_id=v_user;
  return query select c.id,c.reaction_kind,b.client_id,c.source_occurred_at,c.claim_token
  from public.p6_reaction_candidates c left join public.books b on b.id=c.book_id and b.user_id=c.user_id
  where c.id=v_id and c.user_id=v_user;
end $$;

create function public.mark_p6_reaction_displayed(p_reaction_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_updated integer;
begin
  if v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
  update public.p6_reaction_candidates set displayed_at=coalesce(displayed_at,now())
  where id=p_reaction_id and user_id=v_user and resolved_at is null
    and claim_token=p_claim_token and claimed_until>=now();
  get diagnostics v_updated=row_count; return v_updated=1;
end $$;

create function public.dismiss_p6_reaction(p_reaction_id uuid,p_claim_token uuid,p_reason text)
returns boolean language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_updated integer;
begin
  if v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_reason not in ('policy_suppressed','stale') then
    raise exception using errcode='23514',message='Invalid dismissal reason';
  end if;
  update public.p6_reaction_candidates
  set resolved_at=now(),resolution=p_reason,claim_token=null,claimed_until=null
  where id=p_reaction_id and user_id=v_user and resolved_at is null and displayed_at is null
    and claim_token=p_claim_token and claimed_until>=now();
  get diagnostics v_updated=row_count; return v_updated=1;
end $$;

create function public.complete_p6_reaction(p_reaction_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_updated integer;
begin
  if v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
  update public.p6_reaction_candidates set completed_at=coalesce(completed_at,now()),claimed_until=null
  where id=p_reaction_id and user_id=v_user and claim_token=p_claim_token and displayed_at is not null;
  get diagnostics v_updated=row_count; return v_updated=1;
end $$;

create function public.record_p6_character_event(
  p_event_id text,p_event_type text,p_reaction_kind text default null,p_cta_type text default null,p_session_id text default null
) returns boolean language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_event_id is null or char_length(p_event_id) not between 1 and 120 then raise exception using errcode='23514',message='Invalid event id'; end if;
  if p_event_type not in ('app_session_started','positive_page_saved','rabbit_tapped','reaction_cta_clicked') then raise exception using errcode='23514',message='Invalid event type'; end if;
  if p_reaction_kind is not null and p_reaction_kind not in ('completion','first_positive_page','first_book','return','contextual') then raise exception using errcode='23514',message='Invalid reaction kind'; end if;
  if p_cta_type is not null and p_cta_type not in ('book_detail','add_book','library') then raise exception using errcode='23514',message='Invalid CTA type'; end if;
  if p_session_id is not null and char_length(p_session_id) not between 1 and 120 then raise exception using errcode='23514',message='Invalid session id'; end if;
  insert into public.p6_character_events(event_id,user_id,event_type,reaction_kind,cta_type,session_id)
  values(p_event_id,v_user,p_event_type,p_reaction_kind,p_cta_type,p_session_id) on conflict(event_id) do nothing;
  return true;
end $$;

revoke all on function public.claim_p6_reaction() from public,anon;
revoke all on function public.mark_p6_reaction_displayed(uuid,uuid) from public,anon;
revoke all on function public.complete_p6_reaction(uuid,uuid) from public,anon;
revoke all on function public.dismiss_p6_reaction(uuid,uuid,text) from public,anon;
revoke all on function public.record_p6_character_event(text,text,text,text,text) from public,anon;
grant execute on function public.claim_p6_reaction() to authenticated;
grant execute on function public.mark_p6_reaction_displayed(uuid,uuid) to authenticated;
grant execute on function public.complete_p6_reaction(uuid,uuid) to authenticated;
grant execute on function public.dismiss_p6_reaction(uuid,uuid,text) to authenticated;
grant execute on function public.record_p6_character_event(text,text,text,text,text) to authenticated;

create view public.measurement_p6_activation_kpis with (security_invoker=true) as
with cohort as (
  select a.user_id,u.created_at signup_at
  from public.acquisition_attributions a join auth.users u on u.id=a.user_id
  where a.source in ('x','brunch','organic','other')
), positives as (
  select e.user_id,e.occurred_at,(e.occurred_at at time zone 'Asia/Seoul')::date reading_date
  from public.analytics_events e where e.event_type='reading_record_saved' and e.page_delta>0
), first_positive as (
  select user_id,min(occurred_at) first_at from positives group by user_id
), sessions as (
  select user_id,session_id,min(occurred_at) started_at from public.p6_character_events
  where event_type='app_session_started' and session_id is not null group by user_id,session_id
), return_sessions as (
  select s.* from sessions s join first_positive f on f.user_id=s.user_id where s.started_at>f.first_at
)
select
  count(distinct c.user_id) eligible_new_users,
  count(distinct f.user_id) first_positive_users,
  count(distinct f.user_id) repeat_14d_denominator,
  count(distinct f.user_id) filter(where exists(
    select 1 from positives p where p.user_id=f.user_id and p.occurred_at>f.first_at
      and p.occurred_at<=f.first_at+interval '14 days'
      and p.reading_date<>(f.first_at at time zone 'Asia/Seoul')::date
  )) repeat_14d_users,
  (select count(*) from return_sessions) app_return_sessions,
  (select count(*) from return_sessions s where exists(
    select 1 from public.p6_character_events e
    where e.user_id=s.user_id and e.session_id=s.session_id and e.event_type='positive_page_saved'
  )) app_return_converted_sessions
from cohort c left join first_positive f on f.user_id=c.user_id;

revoke all on public.measurement_p6_activation_kpis from public,anon,authenticated;
grant select on public.measurement_p6_activation_kpis to service_role;

commit;
