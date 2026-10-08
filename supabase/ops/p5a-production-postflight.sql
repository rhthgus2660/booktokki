/* READ ONLY. Run immediately after P5-A and before frontend deployment. */
select
  to_regclass('public.user_blocks') is not null as user_blocks_present,
  to_regclass('public.social_reports') is not null as social_reports_present,
  to_regprocedure('public.get_my_social_profile()') is not null as profile_rpc_present,
  to_regprocedure('public.block_friend_connection(uuid)') is not null as block_rpc_present,
  to_regprocedure('public.unblock_user(uuid)') is not null as unblock_rpc_present,
  to_regprocedure('public.report_friend_connection(uuid,text,text)') is not null as report_rpc_present;

select
  has_table_privilege('service_role','public.user_blocks','insert') as service_block_insert,
  has_table_privilege('service_role','public.user_blocks','update') as service_block_update,
  has_table_privilege('service_role','public.user_blocks','delete') as service_block_delete,
  has_table_privilege('service_role','public.user_blocks','truncate') as service_block_truncate,
  has_table_privilege('service_role','public.social_reports','select') as service_report_select,
  has_column_privilege('service_role','public.social_reports','review_status','update') as service_review_status_update,
  has_column_privilege('service_role','public.social_reports','reported_display_name','update') as service_report_snapshot_update;

select
  count(*) filter(where blocked_display_name is null)::bigint as invalid_block_snapshots,
  count(*) filter(where source_connection_id is null)::bigint as invalid_block_handles
from public.user_blocks;
