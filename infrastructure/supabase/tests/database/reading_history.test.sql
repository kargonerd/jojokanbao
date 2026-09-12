begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(11);
set local session_replication_role = replica;
insert into auth.users(id, email) values
 ('00000000-0000-4000-9000-000000008001', 'history-a@example.invalid'),
 ('00000000-0000-4000-9000-000000008002', 'history-b@example.invalid');
set local session_replication_role = origin;
select extensions.ok(not has_function_privilege('anon', 'public.sync_reading_history(uuid,jsonb,bigint)', 'execute'), 'anonymous sync is denied');
select extensions.ok(not has_table_privilege('authenticated', 'public.reader_history', 'UPDATE'), 'direct writes cannot bypass merge');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000008001', true);
select extensions.throws_ok($$select public.sync_reading_history('00000000-0000-4000-9000-000000008002', '[]')$$,
 '42501', 'Reading history account mismatch', 'a switched session cannot write the previous account payload');
select extensions.is(jsonb_array_length(public.sync_reading_history('00000000-0000-4000-9000-000000008001',
 '[{"kind":"book","datasetId":"d","itemKey":"i","title":"书","subtitle":"章","chapterId":"c","chapterProgress":0.8,"progress":80,"updatedAt":20}]')->'records'), 1, 'first device uploads a book');
select extensions.is(public.sync_reading_history('00000000-0000-4000-9000-000000008001',
 '[{"kind":"book","datasetId":"d","itemKey":"i","title":"书","subtitle":"章","progress":10,"updatedAt":10}]') #>> '{records,0,progress}', '80', 'old offline progress cannot rewind newer reading');
select extensions.is(public.sync_reading_history('00000000-0000-4000-9000-000000008001',
 '[{"kind":"book","datasetId":"d","itemKey":"i","title":"书","subtitle":"章","progress":10,"updatedAt":30}]') #>> '{records,0,progress}', '10', 'a later intentional rewind is synced');
select extensions.is(jsonb_array_length(public.sync_reading_history('00000000-0000-4000-9000-000000008001',
 '[{"kind":"periodical","publication":"rmrb","issueId":"19761009","title":"人民日报","subtitle":"","currentPage":4,"totalPages":6,"progress":0,"updatedAt":35}]')->'records'), 2, 'another device adds an issue without deleting books');
select extensions.is(jsonb_array_length(public.sync_reading_history('00000000-0000-4000-9000-000000008001', '[]', 40)->'records'), 0, 'clear removes the account history');
select extensions.is(jsonb_array_length(public.sync_reading_history('00000000-0000-4000-9000-000000008001',
 '[{"kind":"book","datasetId":"d","itemKey":"i","title":"书","subtitle":"章","progress":10,"updatedAt":30}]')->'records'), 0, 'clear tombstone prevents stale device resurrection');
select extensions.throws_ok($$select public.sync_reading_history('00000000-0000-4000-9000-000000008001', '[{"kind":"book"}]')$$,
 '22023', 'Invalid reading record', 'malformed records are rejected');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000008002', true);
set local role authenticated;
select extensions.is((select count(*)::integer from public.reader_history), 0, 'RLS hides another reader history');
reset role;
select * from extensions.finish();
rollback;
