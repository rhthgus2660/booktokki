begin;

/*
 * Clients may only supply user_id and message. id and created_at stay
 * database-managed (defaults), so a table-wide INSERT grant is replaced by a
 * column-level grant. RLS policy feedback_insert_own is unchanged.
 */
revoke insert on table public.feedback from authenticated;
grant insert (user_id, message) on table public.feedback to authenticated;

commit;
