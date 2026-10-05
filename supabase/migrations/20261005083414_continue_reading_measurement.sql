begin;
-- Existing exposure event_id is the only flow key. No new reading tables.
alter table public.analytics_events
  add column continue_reading_id text,
  add column page_delta integer;
alter table public.analytics_events drop constraint analytics_events_event_type_check;
alter table public.analytics_events add constraint analytics_events_event_type_check
  check (event_type in ('book_added','reading_record_saved','continue_reading_viewed','continue_reading_clicked','continue_reading_entered'));
alter table public.analytics_events drop constraint analytics_events_payload_check;
alter table public.analytics_events add constraint analytics_events_payload_check check (
  (event_type='book_added' and with_note is null and continue_reading_id is null and page_delta is null)
  or (event_type='reading_record_saved' and with_note is not null)
  or (event_type in ('continue_reading_viewed','continue_reading_clicked','continue_reading_entered')
      and with_note is null and continue_reading_id is not null and length(continue_reading_id)>0 and page_delta is null)
);
alter table public.analytics_events add constraint analytics_events_page_delta_check
  check (page_delta is null or event_type='reading_record_saved');
alter table public.analytics_events add constraint analytics_events_continue_root_check
  check (event_type <> 'continue_reading_viewed' or continue_reading_id=event_id);
create index analytics_events_continue_reading_idx
  on public.analytics_events(user_id,book_id,continue_reading_id,occurred_at)
  where continue_reading_id is not null;
-- Existing INSERT-only grants and own-user/own-book RLS remain unchanged.
commit;
