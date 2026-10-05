-- Expected: viewed=4 clicked=3 entered=2 positive=1 returning=1. No database writes.
-- Owner-only SELECT; not a public view/RPC. Edit exposure cohort window below.
-- A zero denominator yields NULL rate, never an invented success threshold.
-- Downstream outcomes are bounded by as_of; late cohorts are still immature.
with params as (
  select '2026-10-05 00:00:00+09'::timestamptz as start_at,
         '2026-10-07 00:00:00+09'::timestamptz as end_at, '2026-10-07 00:00:00+09'::timestamptz as as_of
), events as (
  select event_id,user_id,book_id,event_type,occurred_at_text::timestamptz occurred_at,with_note,continue_reading_id,page_delta from (values
('v1','a','a','continue_reading_viewed','2026-10-05 01:00:00+00',null,'v1',null),
('v1c','a','a','continue_reading_clicked','2026-10-05 01:01:00+00',null,'v1',null),
('v1i','a','a','continue_reading_entered','2026-10-05 01:02:00+00',null,'v1',null),
('v1s','a','a','reading_record_saved','2026-10-05 01:03:00+00',null,'v1',10),
('v2','b','b','continue_reading_viewed','2026-10-05 01:00:00+00',null,'v2',null),
('v2c','b','b','continue_reading_clicked','2026-10-05 01:01:00+00',null,'v2',null),
('v2i','b','b','continue_reading_entered','2026-10-05 01:02:00+00',null,'v2',null),
('v2s','b','b','reading_record_saved','2026-10-05 01:03:00+00',null,'v2',0),
('v3','a','a','continue_reading_viewed','2026-10-05 01:00:00+00',null,'v3',null),
('v3c','a','a','continue_reading_clicked','2026-10-05 01:01:00+00',null,'v3',null),
('v3i','a','a','continue_reading_entered','2026-10-05 01:02:00+00',null,'v3',null),
('v3s','a','a','reading_record_saved','2026-10-05 01:03:00+00',null,'v3',10),
('v2neg','b','b','reading_record_saved','2026-10-05 01:04:00+00',null,'v2',-5),
('v2wrong','b','wrong','reading_record_saved','2026-10-05 01:05:00+00',null,'v2',20),
('v2unlinked','b','b','reading_record_saved','2026-10-05 01:06:00+00',null,null,20),
('v4','c','c','continue_reading_viewed','2026-10-05 01:00:00+00',null,'v4',null),
('v5','d','d','continue_reading_viewed','2026-10-05 01:00:00+00',null,'v5',null),
('v5c','d','d','continue_reading_clicked','2026-10-05 01:02:00+00',null,'v5',null),
('v5i','d','d','continue_reading_entered','2026-10-05 01:01:00+00',null,'v5',null),
('v5s','d','d','reading_record_saved','2026-10-05 01:03:00+00',null,'v5',20),
('prior','a','a','reading_record_saved','2026-09-28 01:00:00+00',null,null,null)) as fixture(event_id,user_id,book_id,event_type,occurred_at_text,with_note,continue_reading_id,page_delta)
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
