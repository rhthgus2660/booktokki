\set ON_ERROR_STOP on

create temporary table p9a_room(id uuid);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
insert into p9a_room select public.create_exchange_reading_room(
  (select id from public.books where user_id='00000000-0000-4000-8000-000000000001'),
  array['00000000-0000-4000-8000-000000000101'::uuid,'00000000-0000-4000-8000-000000000102'::uuid]
);

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
select public.accept_exchange_reading_invitation((select id from p9a_room),(select id from public.books where user_id='00000000-0000-4000-8000-000000000002'),false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',false);
select public.accept_exchange_reading_invitation((select id from p9a_room),(select id from public.books where user_id='00000000-0000-4000-8000-000000000003'),false);

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
select * from public.send_exchange_reading_message((select id from p9a_room),'10000000-0000-4000-8000-000000000001','첫 메시지');
select * from public.send_exchange_reading_message((select id from p9a_room),'10000000-0000-4000-8000-000000000001','첫 메시지');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
select public.mark_exchange_reading_room_read((select id from p9a_room),(select id from public.exchange_reading_messages limit 1));
select * from public.list_exchange_reading_rooms();
select * from public.get_exchange_reading_messages((select id from p9a_room),null,null,50);
select public.report_exchange_reading_message((select id from p9a_room),(select id from public.exchange_reading_messages limit 1),'other','synthetic report');

do $$
declare room uuid:=(select id from p9a_room); total integer;
begin
  select count(*) into total from public.exchange_reading_messages where room_id=room;
  if total<>1 then raise exception 'idempotency failed: %',total; end if;
  if (select count(*) from public.exchange_reading_report_evidence where room_id=room)<>1 then raise exception 'evidence missing'; end if;
  if (select count(*) from public.exchange_reading_report_receipts)<>1 then raise exception 'receipt missing'; end if;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
select public.leave_exchange_reading_room((select id from p9a_room));
do $$ begin
  begin
    perform * from public.get_exchange_reading_messages((select id from p9a_room),null,null,50);
    raise exception 'left member read unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);
select public.invite_exchange_reading_friends((select id from p9a_room),array['00000000-0000-4000-8000-000000000101'::uuid]);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false);
select public.accept_exchange_reading_invitation((select id from p9a_room),(select id from public.books where user_id='00000000-0000-4000-8000-000000000002'),false);

do $$ begin
  if (select status from public.exchange_reading_members where room_id=(select id from p9a_room) and user_id='00000000-0000-4000-8000-000000000002')<>'active' then raise exception 'reinvite failed'; end if;
end $$;

\echo 'PASS P9-A Phase 2 PostgreSQL scenarios'
