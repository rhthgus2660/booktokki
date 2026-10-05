-- Owner-run transactional smoke test. Existing user identity is used only
-- inside the transaction; synthetic book/log/events all roll back.
begin;
select set_config('request.jwt.claims',json_build_object('sub',(select id from auth.users order by created_at limit 1),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare
  u uuid := auth.uid(); b uuid := gen_random_uuid(); r record; root text := 'continue-reading-smoke-'||gen_random_uuid();
begin
  if u is null then raise exception 'An existing authenticated user is required'; end if;
  insert into public.books(id,user_id,client_id,title,author,total_pages,current_page,status)
    values(b,u,root,'Continue Reading transaction test','Test',100,10,'reading');
  insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,continue_reading_id)
    values(root,u,b,'continue_reading_viewed',now(),root),
          (root||'-click',u,b,'continue_reading_clicked',now(),root),
          (root||'-entry',u,b,'continue_reading_entered',now(),root);
  select * into r from public.record_page(b,1,root||'-log',30,(now() at time zone 'Asia/Seoul')::date,now());
  if not r.log_created then raise exception 'Positive page record was not created'; end if;
  if (select delta from public.reading_logs where book_id=b and client_id=root||'-log') <> 20 then raise exception 'Unexpected positive delta'; end if;
  insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,with_note,continue_reading_id,page_delta)
    values(root||'-save',u,b,'reading_record_saved',now(),false,root,20);
  select * into r from public.record_page(b,r.revision,root||'-same',30,(now() at time zone 'Asia/Seoul')::date,now());
  if r.log_created then raise exception 'Same-page record should not create a log'; end if;
  insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,with_note,continue_reading_id,page_delta)
    values(root||'-same-save',u,b,'reading_record_saved',now(),false,root,0);
  select * into r from public.record_page(b,r.revision,root||'-back',25,(now() at time zone 'Asia/Seoul')::date,now());
  if (select delta from public.reading_logs where book_id=b and client_id=root||'-back') <> -5 then raise exception 'Unexpected correction delta'; end if;
  insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,with_note,continue_reading_id,page_delta)
    values(root||'-back-save',u,b,'reading_record_saved',now(),false,root,-5);
  -- Legacy clients remain compatible with nullable new columns.
  insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,with_note)
    values(root||'-legacy',u,b,'reading_record_saved',now(),false);
  begin
    insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,continue_reading_id)
      values(root||'-wrong-owner',gen_random_uuid(),b,'continue_reading_viewed',now(),root||'-wrong-owner');
    raise exception 'RLS allowed the wrong user';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,continue_reading_id)
      values(root||'-wrong-book',u,gen_random_uuid(),'continue_reading_viewed',now(),root||'-wrong-book');
    raise exception 'RLS allowed a book not owned by the user';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.analytics_events(event_id,user_id,book_id,event_type,occurred_at,continue_reading_id)
      values(root||'-wrong-root',u,b,'continue_reading_viewed',now(),root);
    raise exception 'Constraint allowed mismatched exposure root';
  exception when check_violation then null; end;
end $$;
rollback;
select 'PASS: positive/same/correction RPC, new and legacy analytics, ownership RLS and root constraint; all writes rolled back' as result;
