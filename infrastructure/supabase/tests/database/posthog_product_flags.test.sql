begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(15);

select extensions.is(private.feature_flag_snapshot('library.bookshelf')->>'rolloutProvider', 'posthog', 'bookshelf rollout is managed in PostHog');
select extensions.is(private.feature_flag_snapshot('reader.annotations')->>'rolloutProvider', 'posthog', 'annotations rollout is managed in PostHog');
select extensions.is(private.feature_flag_snapshot('reader.speech')->>'rolloutProvider', 'posthog', 'speech rollout is managed in PostHog');
select extensions.is(private.feature_flag_snapshot('ai.usage_limits')->>'rolloutProvider', 'supabase', 'mandatory limits remain server managed');
select extensions.ok(not pg_catalog.has_table_privilege('authenticated', 'private.feature_flags', 'select'), 'clients cannot read raw rules, config or history');

create temporary table posthog_flag_test_state (
  owner_id uuid default extensions.gen_random_uuid(),
  other_id uuid default extensions.gen_random_uuid(),
  annotation_config jsonb
);
insert into posthog_flag_test_state(annotation_config) select config from private.feature_flags where key = 'reader.annotations';
set local session_replication_role = replica;
insert into auth.users(id, email, raw_user_meta_data)
select owner_id, 'posthog-owner@example.invalid', '{}'::jsonb from posthog_flag_test_state
union all select other_id, 'posthog-other@example.invalid', '{}'::jsonb from posthog_flag_test_state;
set local session_replication_role = origin;
insert into public.reader_bookshelf(user_id, dataset_id, item_id, title)
select owner_id, 'posthog-test', 'owner-book', 'Owner' from posthog_flag_test_state
union all select other_id, 'posthog-test', 'other-book', 'Other' from posthog_flag_test_state;

-- A legacy off decision must not reject a PostHog-enabled client. Ownership still applies.
update private.feature_flags set rules = '[{"conditionType":"global","serve":false,"enabled":true,"isFallback":true}]'::jsonb
where key in ('library.bookshelf', 'reader.annotations', 'reader.speech');
select set_config('request.jwt.claim.sub', (select owner_id::text from posthog_flag_test_state), true);
select extensions.is((select enabled from public.get_my_feature_flags(array['library.bookshelf'], null)), false, 'old clients retain their original rule evaluator');
select extensions.is(public.feature_enabled('library.bookshelf'), true, 'authenticated bookshelf access is independent of rollout');
select extensions.is(public.feature_enabled('reader.annotations'), true, 'authenticated annotation access is independent of rollout');
select extensions.is(private.require_annotation_reader(), (select owner_id from posthog_flag_test_state), 'annotation RPCs accept an authenticated PostHog client');
select extensions.is((select config from private.feature_flags where key = 'reader.annotations'), (select annotation_config from posthog_flag_test_state), 'rollout changes cannot alter runtime config');

set local role authenticated;
select extensions.is((select count(*) from public.reader_bookshelf where dataset_id = 'posthog-test'), 1::bigint, 'RLS only exposes the current user bookshelf');
select extensions.throws_ok($$insert into public.reader_bookshelf(user_id,dataset_id,item_id,title) values ('00000000-0000-4000-8000-000000000001','posthog-test','forbidden','Forbidden')$$, '42501', 'new row violates row-level security policy for table "reader_bookshelf"', 'PostHog rollout cannot grant writes to another account');
select extensions.is_empty($$delete from public.reader_bookshelf where dataset_id = 'posthog-test' and item_id = 'other-book' returning user_id$$, 'RLS still prevents deleting another account data');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select extensions.is(public.feature_enabled('library.bookshelf'), false, 'signed out users do not gain authenticated data access');
select extensions.throws_ok($$select private.require_annotation_reader()$$, '42501', 'Authentication is required', 'annotation RPCs still require authentication');

select * from extensions.finish();
rollback;
