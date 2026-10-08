/* READ ONLY. Run before P5-A. No user identifiers or profile text are returned. */
select
  to_regclass('public.friend_profiles') is not null as friend_profiles_present,
  to_regclass('public.friend_links') is not null as friend_links_present,
  to_regclass('public.friend_invites') is not null as friend_invites_present,
  to_regclass('public.friend_visit_consents') is not null as friend_visit_consents_present,
  to_regclass('public.app_presence') is not null as app_presence_present,
  to_regprocedure('public.touch_friend_presence()') is not null as touch_friend_presence_present,
  to_regclass('public.user_blocks') is not null as p5a_user_blocks_already_present,
  to_regclass('public.social_reports') is not null as p5a_reports_already_present;

with profile_state as (
  select
    nullif(btrim(u.raw_user_meta_data->>'booktokki_nickname'),'') as legacy_name,
    p.display_name as social_name
  from auth.users u
  left join public.friend_profiles p on p.user_id=u.id
)
select
  count(*)::bigint as total_users,
  count(*) filter(where social_name is not null)::bigint as users_with_social_profile,
  count(*) filter(where social_name is null and legacy_name is not null)::bigint as eligible_backfill_users,
  count(*) filter(where social_name is not null and legacy_name is not null and social_name is distinct from legacy_name)::bigint as differing_name_users
from profile_state;
