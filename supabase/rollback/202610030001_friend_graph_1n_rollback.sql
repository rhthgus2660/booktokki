/*
 * MANUAL ROLLBACK ONLY — never run through the migration runner.
 *
 * Safe only before any user has more than one friend connection and before any
 * user has more than one consent row. If either condition fails, disable
 * FRIEND_VISIT_ENABLED, revoke the v2 RPCs, preserve all relationship data,
 * and ship a forward fix. Never delete a second connection to force rollback.
 */
begin;
set local lock_timeout = '5s';
lock table public.friend_links, public.friend_invites, public.friend_visit_consents in access exclusive mode;

do $$
begin
  if exists (
    select 1 from public.friend_links group by user_id having count(*) > 1
  ) then
    raise exception 'friend graph rollback refused: a user has multiple connections; use a forward fix';
  end if;
  if exists (
    select 1 from public.friend_visit_consents group by user_id having count(*) > 1
  ) then
    raise exception 'friend graph rollback refused: a user has multiple consent rows; use a forward fix';
  end if;
end $$;

revoke all on function public.get_friend_connections() from public,anon,authenticated;
revoke all on function public.touch_friend_presence() from public,anon,authenticated;
revoke all on function public.set_friend_connection_visit(uuid,boolean) from public,anon,authenticated;
revoke all on function public.disconnect_friend_connection(uuid) from public,anon,authenticated;
revoke all on function public.record_friend_rabbit_seen_v2(uuid) from public,anon,authenticated;

alter table public.friend_visit_consents drop constraint if exists friend_visit_consents_connection_fk;
alter table public.friend_visit_consents drop constraint if exists friend_visit_consents_pkey;
alter table public.friend_visit_consents add constraint friend_visit_consents_pkey primary key(user_id);

alter table public.friend_links drop constraint if exists friend_links_mirror_fk;
alter table public.friend_links drop constraint if exists friend_links_pkey;
alter table public.friend_links add constraint friend_links_pkey primary key(user_id);
alter table public.friend_links add constraint friend_links_friend_user_id_key unique(friend_user_id);

/* Legacy wrappers still call this internal helper, so restore its 1:1 upsert. */
create or replace function public.set_friend_connection_visit(p_connection_id uuid,p_allowed boolean)
returns text language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_connection_id is null or p_allowed is null then raise exception using errcode='23514',message='Visit consent decision required'; end if;
  if not exists(select 1 from public.friend_links l where l.connection_id=p_connection_id and l.user_id=auth.uid()) then
    raise exception using errcode='42501',message='Connection not available';
  end if;
  insert into public.friend_visit_consents(user_id,connection_id,allowed,consent_version,decided_at)
  values(auth.uid(),p_connection_id,p_allowed,1,now())
  on conflict(user_id) do update set connection_id=excluded.connection_id,allowed=excluded.allowed,consent_version=excluded.consent_version,decided_at=excluded.decided_at;
  if not p_allowed then delete from public.app_presence where user_id=auth.uid(); end if;
  return case when p_allowed then 'allowed' else 'declined' end;
end; $$;

drop view if exists public.measurement_friend_visit_snapshot;
create view public.measurement_friend_visit_snapshot with (security_invoker=true) as
with connections as (
  select connection_id from public.friend_links group by connection_id having count(*)=2
), current_consents as (
  select c.user_id,c.connection_id,c.allowed
  from public.friend_visit_consents c
  join public.friend_links l on l.user_id=c.user_id and l.connection_id=c.connection_id
  where c.consent_version=1
)
select
  (select count(*) from connections) as connected_pairs,
  (select count(*) from connections x where (select count(*) from current_consents c where c.connection_id=x.connection_id and c.allowed)=2) as mutual_allowed_pairs,
  (select count(*) from public.friend_links l where not exists(select 1 from current_consents c where c.user_id=l.user_id)) as needs_consent_users,
  (select count(*) from current_consents where not allowed) as declined_users;
revoke all on public.measurement_friend_visit_snapshot from public,anon,authenticated;
grant select on public.measurement_friend_visit_snapshot to service_role;

commit;
