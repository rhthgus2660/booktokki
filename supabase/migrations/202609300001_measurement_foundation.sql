begin;

create table public.acquisition_attributions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  source text not null check (source in ('founder','acquaintance','x','brunch','organic','other')),
  campaign text check (campaign is null or (char_length(campaign) between 1 and 80 and campaign ~ '^[A-Za-z0-9._-]+$')),
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.acquisition_attributions enable row level security;
revoke all on table public.acquisition_attributions from anon, authenticated;

create table public.measurement_events (
  event_id text primary key check (char_length(event_id) between 1 and 120),
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'login_started','login_completed','login_failed','sync_failed','restore_failed',
    'friend_invite_created','friend_invite_accepted','friend_invite_failed'
  )),
  occurred_at timestamptz not null default now(),
  error_code text check (error_code is null or error_code in ('cancelled','network','provider','auth','permission','validation','conflict','timeout','unknown')),
  context text check (context is null or context in ('oauth','bootstrap','cloud_restore','friend_invite')),
  created_at timestamptz not null default now(),
  constraint measurement_event_identity check (
    (event_type in ('login_started','login_failed') and user_id is null)
    or (event_type not in ('login_started','login_failed') and user_id is not null)
  )
);
create index measurement_events_type_occurred_idx on public.measurement_events(event_type,occurred_at);
create index measurement_events_user_occurred_idx on public.measurement_events(user_id,occurred_at) where user_id is not null;
alter table public.measurement_events enable row level security;
revoke all on table public.measurement_events from anon, authenticated;

create function public.claim_acquisition_source(p_source text,p_campaign text default null,p_first_seen_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_created_at timestamptz; v_source text:=lower(btrim(p_source)); v_campaign text:=nullif(btrim(p_campaign),''); v_first_seen timestamptz:=coalesce(p_first_seen_at,now()); v_inserted integer;
begin
 if v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
 if exists(select 1 from public.acquisition_attributions where user_id=v_user) then return false; end if;
 select created_at into v_created_at from auth.users where id=v_user;
 if v_created_at is null or now()>v_created_at+interval '24 hours' then return false; end if;
 if v_source not in ('founder','acquaintance','x','brunch','organic','other') then raise exception using errcode='23514',message='Invalid acquisition source'; end if;
 if v_campaign is not null and (char_length(v_campaign)>80 or v_campaign !~ '^[A-Za-z0-9._-]+$') then raise exception using errcode='23514',message='Invalid campaign'; end if;
 if v_first_seen < now()-interval '30 days' or v_first_seen > now()+interval '5 minutes' then v_first_seen:=now(); end if;
 insert into public.acquisition_attributions(user_id,source,campaign,first_seen_at) values(v_user,v_source,v_campaign,v_first_seen) on conflict(user_id) do nothing;
 get diagnostics v_inserted=row_count; return v_inserted=1;
end $$;

create function public.record_measurement_event(p_event_id text,p_event_type text,p_error_code text default null,p_context text default null)
returns boolean language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_type text:=btrim(p_event_type); v_error text:=nullif(btrim(p_error_code),''); v_context text:=nullif(btrim(p_context),'');
begin
 if p_event_id is null or char_length(p_event_id) not between 1 and 120 then raise exception using errcode='23514',message='Invalid event id'; end if;
 if v_type not in ('login_started','login_completed','login_failed','sync_failed','restore_failed','friend_invite_created','friend_invite_accepted','friend_invite_failed') then raise exception using errcode='23514',message='Invalid event type'; end if;
 if v_type not in ('login_started','login_failed') and v_user is null then raise exception using errcode='42501',message='Authentication required'; end if;
 if v_error is not null and v_error not in ('cancelled','network','provider','auth','permission','validation','conflict','timeout','unknown') then raise exception using errcode='23514',message='Invalid error code'; end if;
 if v_context is not null and v_context not in ('oauth','bootstrap','cloud_restore','friend_invite') then raise exception using errcode='23514',message='Invalid context'; end if;
 insert into public.measurement_events(event_id,user_id,event_type,error_code,context) values(p_event_id,v_user,v_type,v_error,v_context) on conflict(event_id) do nothing;
 return true;
end $$;
revoke all on function public.claim_acquisition_source(text,text,timestamptz) from public,anon;
grant execute on function public.claim_acquisition_source(text,text,timestamptz) to authenticated;
revoke all on function public.record_measurement_event(text,text,text,text) from public;
grant execute on function public.record_measurement_event(text,text,text,text) to anon,authenticated;

create view public.measurement_weekly_kpis with (security_invoker=true) as
with signup_cohorts as (
 select u.id user_id,
   (u.created_at at time zone 'Asia/Seoul')::date signup_date,
   date_trunc('week',u.created_at at time zone 'Asia/Seoul')::date signup_week
 from auth.users u
), reading_events as (
 select e.event_id,e.user_id,(e.occurred_at at time zone 'Asia/Seoul')::date reading_date,
   date_trunc('week',e.occurred_at at time zone 'Asia/Seoul')::date reading_week
 from public.analytics_events e where e.event_type='reading_record_saved'
), first_reads as (
 select user_id,min(reading_date) first_reading_date from reading_events group by user_id
), weeks as (
 select generate_series((select min(signup_week) from signup_cohorts),date_trunc('week',now() at time zone 'Asia/Seoul')::date,interval '1 week')::date week_start
)
select w.week_start,
 count(distinct c.user_id) new_signups,
 count(distinct r.user_id) filter(where r.reading_week=w.week_start) active_readers,
 count(distinct f.user_id) filter(where date_trunc('week',f.first_reading_date)::date=w.week_start) new_active_readers,
 count(distinct r.user_id) filter(where r.reading_week=w.week_start and f.first_reading_date<w.week_start) returning_active_readers,
 count(distinct c.user_id) filter(where exists(select 1 from reading_events ar where ar.user_id=c.user_id and ar.reading_date between c.signup_date and c.signup_date+6)) activation_numerator,
 count(distinct c.user_id) activation_denominator,
 count(distinct c.user_id) filter(where exists(select 1 from reading_events ar where ar.user_id=c.user_id and ar.reading_date between c.signup_date and c.signup_date+6))::numeric/nullif(count(distinct c.user_id),0) activation_rate,
 case when (now() at time zone 'Asia/Seoul')::date < w.week_start+21 then null else count(distinct c.user_id) filter(where exists(select 1 from reading_events d where d.user_id=c.user_id and d.reading_date between c.signup_date+7 and c.signup_date+13)) end d7_numerator,
 case when (now() at time zone 'Asia/Seoul')::date < w.week_start+21 then null else count(distinct c.user_id) end d7_denominator,
 case when (now() at time zone 'Asia/Seoul')::date < w.week_start+21 then null else count(distinct c.user_id) filter(where exists(select 1 from reading_events d where d.user_id=c.user_id and d.reading_date between c.signup_date+7 and c.signup_date+13))::numeric/nullif(count(distinct c.user_id),0) end d7,
 case when (now() at time zone 'Asia/Seoul')::date < w.week_start+43 then null else count(distinct c.user_id) filter(where exists(select 1 from reading_events d where d.user_id=c.user_id and d.reading_date between c.signup_date+30 and c.signup_date+36)) end d30_numerator,
 case when (now() at time zone 'Asia/Seoul')::date < w.week_start+43 then null else count(distinct c.user_id) end d30_denominator,
 case when (now() at time zone 'Asia/Seoul')::date < w.week_start+43 then null else count(distinct c.user_id) filter(where exists(select 1 from reading_events d where d.user_id=c.user_id and d.reading_date between c.signup_date+30 and c.signup_date+36))::numeric/nullif(count(distinct c.user_id),0) end d30,
 count(distinct r.user_id) filter(where r.reading_week=w.week_start) war,
 count(distinct r.event_id) filter(where r.reading_week=w.week_start) reading_records
from weeks w
left join signup_cohorts c on c.signup_week=w.week_start
left join reading_events r on r.reading_week=w.week_start
left join first_reads f on f.user_id=r.user_id
group by w.week_start;

create view public.measurement_acquisition_kpis with (security_invoker=true) as
select a.source,count(distinct a.user_id) signups,count(distinct l.user_id) active_readers,count(distinct l.user_id)::numeric/nullif(count(distinct a.user_id),0) activation_rate,count(distinct case when f.first_week<l.activity_week then l.user_id end) returning_readers
from public.acquisition_attributions a
left join (select distinct user_id,date_trunc('week',occurred_at at time zone 'Asia/Seoul')::date activity_week from public.analytics_events where event_type='reading_record_saved') l on l.user_id=a.user_id
left join (select user_id,date_trunc('week',min(occurred_at) at time zone 'Asia/Seoul')::date first_week from public.analytics_events where event_type='reading_record_saved' group by user_id) f on f.user_id=a.user_id
group by a.source;

create view public.measurement_p5_kpis with (security_invoker=true) as
with weeks as (
 select date_trunc('week',occurred_at at time zone 'Asia/Seoul')::date week_start from public.measurement_events
 union select date_trunc('week',occurred_at at time zone 'Asia/Seoul')::date from public.presence_analytics_events
)
select w.week_start,
 (select count(*) from public.measurement_events m where date_trunc('week',m.occurred_at at time zone 'Asia/Seoul')::date=w.week_start and m.event_type='friend_invite_created') invite_created,
 (select count(*) from public.measurement_events m where date_trunc('week',m.occurred_at at time zone 'Asia/Seoul')::date=w.week_start and m.event_type='friend_invite_accepted') friend_connected,
 (select count(*) from public.presence_analytics_events p where date_trunc('week',p.occurred_at at time zone 'Asia/Seoul')::date=w.week_start and p.event_type='reading_presence_started') presence_started,
 (select count(*) from public.presence_analytics_events p where date_trunc('week',p.occurred_at at time zone 'Asia/Seoul')::date=w.week_start and p.event_type='co_reading_seen') co_reading_seen
from weeks w;

create view public.measurement_friction_kpis with (security_invoker=true) as
select date_trunc('week',occurred_at at time zone 'Asia/Seoul')::date week_start,
 case when event_type like 'login_%' then 'login' when event_type like 'sync_%' then 'sync' when event_type like 'restore_%' then 'restore' else 'friend_invite' end flow,
 count(*) filter(where event_type in ('login_started','friend_invite_created','friend_invite_failed')) attempts,
 count(*) filter(where event_type in ('login_completed','friend_invite_created','friend_invite_accepted')) successes,
 count(*) filter(where event_type in ('login_failed','sync_failed','restore_failed','friend_invite_failed')) failures,
 count(distinct user_id) filter(where event_type in ('login_failed','sync_failed','restore_failed','friend_invite_failed')) affected_users,
 count(*) filter(where event_type in ('login_failed','sync_failed','restore_failed','friend_invite_failed'))::numeric/nullif(count(*) filter(where event_type in ('login_started','friend_invite_created','friend_invite_failed')),0) failure_rate
from public.measurement_events group by 1,2;

revoke all on public.measurement_weekly_kpis,public.measurement_acquisition_kpis,public.measurement_p5_kpis,public.measurement_friction_kpis from anon,authenticated;
grant select on public.measurement_weekly_kpis,public.measurement_acquisition_kpis,public.measurement_p5_kpis,public.measurement_friction_kpis to service_role;
commit;
