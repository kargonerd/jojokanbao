begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

select extensions.has_table(
  'public',
  'times_article_reads',
  'Times read state has a dedicated table'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.times_article_reads', 'select'),
  'browser users cannot read Times state directly'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_my_times_article_reads(text[])',
    'execute'
  ),
  'authenticated readers can query their Times read state through an RPC'
);

create temporary table times_read_test_state (
  reader_id uuid not null default extensions.gen_random_uuid(),
  other_id uuid not null default extensions.gen_random_uuid()
);
insert into times_read_test_state default values;

set local session_replication_role = replica;
insert into auth.users(id, email, raw_user_meta_data)
select reader_id, 'times-reader@example.invalid', '{}'::jsonb from times_read_test_state
union all
select other_id, 'times-other@example.invalid', '{}'::jsonb from times_read_test_state;
set local session_replication_role = origin;

select pg_catalog.set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok(
  $$select public.mark_my_times_article_read('article-1', '2026-08-29')$$,
  'P0001',
  'Authentication required',
  'anonymous readers cannot write read state'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  (select reader_id::text from times_read_test_state),
  true
);
select extensions.ok(
  public.mark_my_times_article_read('article-1', '2026-08-29') is not null,
  'opening an article marks it read'
);
select extensions.is(
  (select count(*)::integer from public.get_my_times_article_reads(array['article-1', 'article-2'])),
  1,
  'batch lookup returns only read articles'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  (select other_id::text from times_read_test_state),
  true
);
select extensions.is(
  (select count(*)::integer from public.get_my_times_article_reads(array['article-1'])),
  0,
  'read state is private to each reader'
);
select public.mark_my_times_article_read('article-1', '2026-08-28');

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  (select reader_id::text from times_read_test_state),
  true
);
select public.mark_my_times_article_unread('article-1');
select extensions.is(
  (select count(*)::integer from public.get_my_times_article_reads(array['article-1'])),
  0,
  'marking an article unread removes the current reader state'
);
select extensions.is(
  (select count(*)::integer from public.times_article_reads where article_id = 'article-1'),
  1,
  'marking unread does not remove another reader state'
);
select extensions.throws_ok(
  $$select * from public.get_my_times_article_reads(array_fill('x'::text, array[501]))$$,
  'P0001',
  'Invalid Times article ids',
  'batch reads have a bounded request size'
);
select extensions.throws_ok(
  $$select public.mark_my_times_article_read('', '2026-08-29')$$,
  'P0001',
  'Invalid Times article read',
  'empty article ids are rejected'
);
select extensions.throws_ok(
  $$select public.mark_my_times_article_unread('')$$,
  'P0001',
  'Invalid Times article id',
  'invalid unread requests are rejected'
);

select * from extensions.finish();
rollback;
