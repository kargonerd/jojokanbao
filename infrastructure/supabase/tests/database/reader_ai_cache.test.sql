begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(18);

select extensions.has_table(
  'public',
  'reader_ai_explanation_cache',
  'Reader AI explanations use one shared cache table'
);
select extensions.hasnt_table(
  'public',
  'reader_ai_explanations',
  'the legacy per-user explanation table is removed'
);
select extensions.hasnt_column(
  'public',
  'reader_ai_explanation_cache',
  'user_id',
  'the shared cache stores no reader identifier'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.reader_ai_explanation_cache', 'select'),
  'authenticated readers cannot read the cache table directly'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.reader_ai_explanation_cache', 'insert'),
  'authenticated readers cannot insert cache rows directly'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_reader_ai_explanation_cache(text,text,text,text,text)',
    'execute'
  ),
  'authenticated readers can use the narrow cache read RPC'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.put_reader_ai_explanation_cache(text,text,text,text,text,text,text,text,jsonb,text,text)',
    'execute'
  ),
  'authenticated readers can use the narrow cache write RPC'
);

select pg_catalog.set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok(
  $$select * from public.get_reader_ai_explanation_cache(
    'book-a', 'book-a:item-a', 'chapter:1', '["前文","原文","后文"]', 'reader-focus-v1'
  )$$,
  'P0001',
  'Authentication required',
  'cache reads require an authenticated reader'
);

create temporary table reader_ai_cache_test_state (
  reader_id uuid not null default extensions.gen_random_uuid()
);
insert into reader_ai_cache_test_state default values;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  (select reader_id::text from reader_ai_cache_test_state),
  true
);

select public.put_reader_ai_explanation_cache(
  'book-a',
  'book-a:item-a',
  'chapter:1',
  '["甲前文","同一句","甲后文"]',
  '同一句',
  '甲前文',
  '甲后文',
  '甲的解释[cite:J1]',
  '[{"citationId":"J1","datasetId":"book-a","itemId":"book-a:item-a","targetId":"chapter:1"}]'::jsonb,
  'openai-codex/test',
  'reader-focus-v1'
);
select public.put_reader_ai_explanation_cache(
  'book-a',
  'book-a:item-a',
  'chapter:1',
  '["乙前文","同一句","乙后文"]',
  '同一句',
  '乙前文',
  '乙后文',
  '乙的解释[cite:J2]',
  '[{"citationId":"J2","datasetId":"book-a","itemId":"book-a:item-a","targetId":"chapter:1"}]'::jsonb,
  'openai-codex/test',
  'reader-focus-v1'
);

select extensions.is(
  (select count(*)::integer from public.reader_ai_explanation_cache),
  2,
  'identical quotes with different context use different cache rows'
);
select extensions.is(
  (
    select count(distinct cache_key)::integer
    from public.reader_ai_explanation_cache
    where char_length(cache_key) = 64
  ),
  2,
  'cache identity uses distinct fixed-size SHA-256 keys'
);
select extensions.is(
  (
    select answer
    from public.get_reader_ai_explanation_cache(
      'book-a', 'book-a:item-a', 'chapter:1', '["甲前文","同一句","甲后文"]', 'reader-focus-v1'
    )
  ),
  '甲的解释[cite:J1]',
  'a context-specific cache read returns its own answer'
);
select extensions.is(
  (
    select query_count
    from public.reader_ai_explanation_cache
    where context_key = '["甲前文","同一句","甲后文"]'
  ),
  2::bigint,
  'a cache hit increments the anonymous query count atomically'
);
select extensions.is(
  (
    select query_count
    from public.reader_ai_explanation_cache
    where context_key = '["乙前文","同一句","乙后文"]'
  ),
  1::bigint,
  'a different context keeps an independent query count'
);

select public.put_reader_ai_explanation_cache(
  'book-a',
  'book-a:item-a',
  'chapter:1',
  '["甲前文","同一句","甲后文"]',
  '同一句',
  '甲前文',
  '甲后文',
  '不应覆盖的并发答案',
  '[]'::jsonb,
  'other/model',
  'reader-focus-v1'
);

select extensions.is(
  (
    select answer
    from public.reader_ai_explanation_cache
    where context_key = '["甲前文","同一句","甲后文"]'
  ),
  '甲的解释[cite:J1]',
  'a concurrent cache fill cannot overwrite the first completed answer'
);
select extensions.is(
  (
    select query_count
    from public.reader_ai_explanation_cache
    where context_key = '["甲前文","同一句","甲后文"]'
  ),
  3::bigint,
  'a concurrent cache fill still contributes to the anonymous count'
);
select extensions.is(
  (
    select prefix
    from public.get_popular_reader_ai_explanations(
      'book-a', 'book-a:item-a', 'chapter:1', 'reader-focus-v1'
    )
  ),
  '甲前文',
  'popular explanations preserve the context needed to locate the quote'
);
select extensions.is(
  (
    select model
    from public.reader_ai_explanation_cache
    where context_key = '["甲前文","同一句","甲后文"]'
  ),
  'openai-codex/test',
  'the cache retains model provenance from the first completed answer'
);
select extensions.is(
  (select description from private.feature_flags where key = 'reader.annotations'),
  '划线和想法',
  'annotation flag copy no longer claims to control Reader AI explanations'
);

select * from extensions.finish();
rollback;
