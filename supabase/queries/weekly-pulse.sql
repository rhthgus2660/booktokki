-- Run with a desired week start; defaults below to the current ISO week.
with p as (select date_trunc('week',now() at time zone 'Asia/Seoul')::date period_start),
w as (select k.* from public.measurement_weekly_kpis k,p where k.week_start=p.period_start),
s as (select k.* from public.measurement_p5_kpis k,p where k.week_start=p.period_start),
f as (select jsonb_object_agg(flow,jsonb_build_object('attempts',attempts,'successes',successes,'failures',failures,'affected_users',affected_users,'failure_rate',failure_rate)) value from public.measurement_friction_kpis k,p where k.week_start=p.period_start),
a as (select jsonb_object_agg(source,jsonb_build_object('signups',signups,'active_readers',active_readers,'activation_rate',activation_rate,'returning_readers',returning_readers)) value from public.measurement_acquisition_kpis)
select jsonb_build_object(
 'title','BOOKTOKKI WEEKLY PULSE','period',p.period_start,
 'growth',jsonb_build_object('new_signups',w.new_signups,'active_readers',w.active_readers,'activation',w.activation_rate,'activation_n',w.activation_numerator,'activation_denominator',w.activation_denominator,'returning_active_readers',w.returning_active_readers,'d7',w.d7,'d7_n',w.d7_numerator,'d7_denominator',w.d7_denominator,'d30',w.d30,'d30_n',w.d30_numerator,'d30_denominator',w.d30_denominator,'war',w.war,'reading_records',w.reading_records),
 'social',jsonb_build_object('friend_connected',coalesce(s.friend_connected,0),'presence_started',coalesce(s.presence_started,0),'co_reading_seen',coalesce(s.co_reading_seen,0)),
 'acquisition',coalesce(a.value,'{}'::jsonb),'friction',coalesce(f.value,'{}'::jsonb),'revenue','₩0','interpretation',null
) weekly_pulse from p left join w on true left join s on true cross join a cross join f;
