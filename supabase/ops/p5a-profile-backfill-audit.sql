/* READ ONLY. Run in Supabase SQL Editor before the P5-A migration.
   Returns aggregate counts only; no nickname or user identifier is emitted. */
with profile_state as (
  select
    u.id,
    nullif(btrim(u.raw_user_meta_data->>'booktokki_nickname'),'') as legacy_name,
    p.display_name as social_name
  from auth.users u
  left join public.friend_profiles p on p.user_id=u.id
)
select
  count(*)::bigint as total_users,
  count(*) filter(where social_name is not null)::bigint as users_with_social_profile,
  count(*) filter(where social_name is null and legacy_name is not null)::bigint as eligible_backfill_users,
  count(*) filter(where social_name is not null and legacy_name is not null and social_name is distinct from legacy_name)::bigint as differing_name_users,
  count(*) filter(where social_name is null and legacy_name is null)::bigint as users_needing_profile_input
from profile_state;
