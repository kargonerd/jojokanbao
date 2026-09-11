begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.has_table('public', 'content_corrections', 'corrections retain private reading context');
select extensions.ok((select relrowsecurity from pg_class where oid = 'public.content_corrections'::regclass), 'RLS is enabled');
select extensions.ok(not has_table_privilege('anon', 'public.content_corrections', 'select'), 'anonymous users cannot read feedback');
select extensions.ok(not has_table_privilege('authenticated', 'public.content_corrections', 'insert'), 'readers cannot forge owner or initial status via direct insert');
select extensions.ok(not has_table_privilege('authenticated', 'public.content_corrections', 'update'), 'readers cannot change review results');
select extensions.ok(not has_function_privilege('anon', 'public.submit_content_correction(text,text,text,text,text,text,text,uuid,text,text,text)', 'execute'), 'anonymous submission is not granted');

set local session_replication_role = replica;
insert into auth.users(id, email, raw_user_meta_data) values
  ('90800200-0000-0000-0000-000000000001', 'correction-one@example.invalid', '{}'::jsonb),
  ('90800200-0000-0000-0000-000000000002', 'correction-two@example.invalid', '{}'::jsonb);
set local session_replication_role = origin;
insert into private.feature_flag_operator_secret(singleton, token_digest)
  values (true, extensions.digest(repeat('o', 32), 'sha256'))
  on conflict (singleton) do update set token_digest = excluded.token_digest;

select set_config('request.jwt.claim.sub', '90800200-0000-0000-0000-000000000001', true);
set local role authenticated;
select extensions.is(public.submit_content_correction(
  'correction-request-0001', 'book', 'collection:book', '测试书', '/book/collection/book?chapter=2', 'typo', '铁路一词有误', '90800200-0000-0000-0000-000000000001', '2', '第二章', '错误原文'
)->>'status', 'pending', 'authenticated reader receives a saved pending receipt');
select extensions.is((select count(*) from public.content_corrections), 1::bigint, 'owner can read their correction through RLS');
select extensions.is(jsonb_array_length(public.get_my_content_corrections()), 1, 'own history returns the correction');
select extensions.is(public.get_my_content_corrections()->0->>'sectionId', '2', 'chapter context is preserved');
select extensions.is(public.get_my_content_corrections()->0->>'quote', '错误原文', 'original text is preserved');
select extensions.is(jsonb_array_length(public.get_my_content_corrections('newspaper', 'collection:book')), 0, 'history filters by content kind');
select extensions.is(public.submit_content_correction(
  'correction-request-0001', 'book', 'collection:book', '测试书', '/book/collection/book?chapter=2', 'typo', '铁路一词有误', '90800200-0000-0000-0000-000000000001'
)->>'id', public.get_my_content_corrections()->0->>'id', 'retrying the same request returns the original receipt');
select extensions.is((select count(*) from public.content_corrections), 1::bigint, 'retry does not create a duplicate');
select extensions.throws_ok($$select public.submit_content_correction('correction-request-unsafe', 'book', 'book', '测试书', '//outside.invalid', 'typo', '文字错误', '90800200-0000-0000-0000-000000000001')$$, '23514', null, 'database rejects external or protocol-relative reading links');
select extensions.throws_ok($$select public.submit_content_correction('correction-request-empty', 'book', 'book', '测试书', '/book/test', 'typo', ' ', '90800200-0000-0000-0000-000000000001')$$, '23514', null, 'database rejects empty descriptions');

reset role;
select set_config('request.jwt.claim.sub', '90800200-0000-0000-0000-000000000002', true);
set local role authenticated;
select extensions.is((select count(*) from public.content_corrections), 0::bigint, 'another reader cannot query the first reader feedback');
select extensions.is(jsonb_array_length(public.get_my_content_corrections()), 0, 'history RPC never reveals another reader feedback');
select extensions.is(public.submit_content_correction(
  'correction-request-0001', 'book', 'collection:book', '测试书', '/book/collection/book', 'missing_page', '缺少第三页', '90800200-0000-0000-0000-000000000002'
)->>'status', 'pending', 'retry keys are scoped to the reader');
select extensions.throws_ok($$select public.submit_content_correction('correction-wrong-owner', 'book', 'book', '测试书', '/book/test', 'typo', '文字错误', '90800200-0000-0000-0000-000000000001')$$, '42501', 'The submitting account changed', 'a stale form cannot submit under a switched account');
reset role;

select extensions.throws_ok($$select public.operator_list_content_corrections('wrong-token')$$, '42501', 'Feature flag operator token is invalid', 'queue listing requires the existing operator token');
select extensions.throws_ok($$select public.operator_review_content_correction('wrong-token', '90800200-0000-0000-0000-000000000099', 'resolved', '已校正')$$, '42501', 'Feature flag operator token is invalid', 'resolution requires the existing operator token');
select extensions.is(public.operator_list_content_corrections(repeat('o', 32))->>'total', '2', 'operator sees both readers corrections');
select extensions.is(jsonb_array_length(public.operator_list_content_corrections(repeat('o', 32), 'pending', 1)->'items'), 1, 'queue pagination is bounded and works');
select extensions.throws_ok($$select public.operator_review_content_correction(repeat('o',32), '90800200-0000-0000-0000-000000000099', 'resolved', '')$$, '22023', 'Correction review note is required', 'resolution must contain a reader-visible explanation');
select extensions.is(public.operator_review_content_correction(
  repeat('o', 32), (select id from public.content_corrections where user_id = '90800200-0000-0000-0000-000000000001'), 'resolved', '原文已校正'
)->>'status', 'resolved', 'operator can mark an actual correction resolved');

select set_config('request.jwt.claim.sub', '90800200-0000-0000-0000-000000000001', true);
set local role authenticated;
select extensions.is(public.get_my_content_corrections()->0->>'resolutionNote', '原文已校正', 'owner can read the resolution note');
select extensions.is(public.get_my_content_corrections()->0->>'status', 'resolved', 'owner sees the actual reviewed status');
reset role;
select set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok($$select public.get_my_content_corrections()$$, '42501', 'Authentication is required', 'history RPC requires an authenticated subject');

select * from extensions.finish();
rollback;
