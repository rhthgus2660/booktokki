-- Owner-only SELECT; not a public view/RPC. Edit exposure cohort window below.
-- A zero denominator yields NULL rate, never an invented success threshold.
-- Downstream outcomes are bounded by as_of; late cohorts are still immature.
with params as (
  select '2026-10-05 00:00:00+09'::timestamptz as start_at,
         now() as end_at, now() as as_of
), events as (
  select * from public.analytics_events
), exposures as (
  select e.* from events e, params p
  where e.event_type='continue_reading_viewed' and e.event_id=e.continue_reading_id
    and e.occurred_at>=p.start_at and e.occurred_at<p.end_at
), flows as (
  select v.user_id,v.event_id,v.occurred_at viewed_at,c.at clicked_at,i.at entered_at,s.at saved_at,
    exists(select 1 from events old where old.user_id=v.user_id
      and old.event_type='reading_record_saved'
      and old.occurred_at < date_trunc('week',s.at at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') returning_reader
  from exposures v
  left join lateral (
    select min(e.occurred_at) at from events e,params p
    where e.user_id=v.user_id and e.book_id=v.book_id and e.continue_reading_id=v.event_id
      and e.event_type='continue_reading_clicked' and e.occurred_at>=v.occurred_at and e.occurred_at<=p.as_of
  ) c on true
  left join lateral (
    select min(e.occurred_at) at from events e,params p
    where e.user_id=v.user_id and e.book_id=v.book_id and e.continue_reading_id=v.event_id
      and e.event_type='continue_reading_entered' and e.occurred_at>=c.at and e.occurred_at<=p.as_of
  ) i on true
  left join lateral (
    select min(e.occurred_at) at from events e,params p
    where e.user_id=v.user_id and e.book_id=v.book_id and e.continue_reading_id=v.event_id
      and e.event_type='reading_record_saved' and e.page_delta>0 and e.occurred_at>=i.at and e.occurred_at<=p.as_of
  ) s on true
), counts as (
  select count(distinct user_id) viewed_users,
    count(distinct user_id) filter(where clicked_at is not null) clicked_users,
    count(distinct user_id) filter(where entered_at is not null) entered_users,
    count(distinct user_id) filter(where saved_at is not null) positive_record_users,
    count(distinct user_id) filter(where saved_at is not null and returning_reader) returning_positive_record_users
  from flows
)
select *,
  clicked_users cta_numerator,viewed_users cta_denominator, clicked_users::numeric/nullif(viewed_users,0) cta_rate,
  entered_users entry_numerator,clicked_users entry_denominator, entered_users::numeric/nullif(clicked_users,0) entry_rate,
  positive_record_users record_numerator,entered_users record_denominator, positive_record_users::numeric/nullif(entered_users,0) record_rate,
  positive_record_users overall_numerator,viewed_users overall_denominator, positive_record_users::numeric/nullif(viewed_users,0) overall_rate
from counts;
