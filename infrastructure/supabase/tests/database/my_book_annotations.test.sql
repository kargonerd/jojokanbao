begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(33);

select extensions.has_function('public', 'get_my_book_annotations', array['text', 'uuid', 'integer'], 'book notes expose a keyset page RPC');
select extensions.ok(has_function_privilege('authenticated', 'public.get_my_book_annotations(text,uuid,integer)', 'execute'), 'authenticated readers may load their book notes');
select extensions.ok(not has_function_privilege('anon', 'public.get_my_book_annotations(text,uuid,integer)', 'execute'), 'anonymous callers cannot execute the RPC');
select extensions.ok(not exists (
  select 1 from pg_proc function
  cross join lateral aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) permission
  where function.oid = 'public.get_my_book_annotations(text,uuid,integer)'::regprocedure
    and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
), 'PUBLIC does not inherit permission to load reader notes');

set local session_replication_role = replica;
insert into auth.users(id, email) values
 ('00000000-0000-4000-9000-000000009301', 'book-notes-owner@example.invalid'),
 ('00000000-0000-4000-9000-000000009302', 'book-notes-other@example.invalid'),
 ('00000000-0000-4000-9000-000000009303', 'book-notes-empty@example.invalid');
set local session_replication_role = origin;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select extensions.throws_ok($$select public.get_my_book_annotations('notes-book')$$,
 '42501', 'Authentication is required', 'even an empty book requires authentication');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009301', true);

select extensions.throws_ok($$select public.get_my_book_annotations('notes-book', null, 0)$$,
 '22023', 'Book annotation limit must be between 1 and 100', 'zero limit is rejected');
select extensions.throws_ok($$select public.get_my_book_annotations('notes-book', null, -1)$$,
 '22023', 'Book annotation limit must be between 1 and 100', 'negative limit is rejected');
select extensions.throws_ok($$select public.get_my_book_annotations('notes-book', null, 101)$$,
 '22023', 'Book annotation limit must be between 1 and 100', 'oversized limit is rejected');
select extensions.throws_ok($$select public.get_my_book_annotations('notes-book', null, null)$$,
 '22023', 'Book annotation limit must be between 1 and 100', 'null cannot mean unlimited');

insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key, moderation_status, created_at)
select ('00000000-0000-4000-9000-' || lpad(number::text, 12, '0'))::uuid,
  content_type, content_id, 'chapter-' || number, '测试书',
  case when number = 9314 then '00000000-0000-4000-9000-000000009301'::uuid
    else '00000000-0000-4000-9000-000000009302'::uuid end,
  '原文 ' || number, repeat(md5(number::text), 2), moderation_status,
  '2026-09-01'::timestamptz - (number - 9310) * interval '1 day'
from (values
  (9310, 'book', 'notes-book', 'visible'), -- A's mark on an anchor first created by B
  (9311, 'book', 'notes-book', 'visible'), -- A's private thought without any mark
  (9312, 'book', 'notes-book', 'visible'), -- A's mark and public thought count as one thread
  (9314, 'book', 'notes-book', 'visible'), -- Being the original author is not a current mark
  (9315, 'book', 'notes-book', 'visible'), -- Only B's public thought
  (9316, 'book', 'notes-book', 'visible'), -- Only B's private thought
  (9317, 'book', 'notes-book', 'hidden'),  -- A's mark and thought on a moderated anchor
  (9318, 'book', 'notes-book', 'visible'), -- Only A's moderated thought
  (9319, 'book', 'another-book', 'visible'),
  (9320, 'newspaper', 'notes-book', 'visible'),
  (9321, 'magazine', 'notes-book', 'visible'),
  (9322, 'article', 'notes-book', 'visible'),
  (9323, 'book', 'notes-book', 'visible')  -- Mixed authors and comment visibility
) fixture(number, content_type, content_id, moderation_status);

insert into public.content_annotation_marks(annotation_id, user_id)
select ('00000000-0000-4000-9000-' || lpad(number::text, 12, '0'))::uuid,
  '00000000-0000-4000-9000-000000009301'::uuid
from unnest(array[9310, 9312, 9317, 9319, 9320, 9321, 9322, 9323]) number;

insert into public.annotation_comments(id, annotation_id, user_id, body, visibility, moderation_status, created_at)
select ('00000000-0000-4000-9000-' || lpad(number::text, 12, '0'))::uuid,
  ('00000000-0000-4000-9000-' || lpad(annotation_number::text, 12, '0'))::uuid,
  ('00000000-0000-4000-9000-' || lpad(reader_number::text, 12, '0'))::uuid,
  '想法 ' || number, visibility, moderation_status, '2026-09-01'::timestamptz
from (values
  (9511, 9311, 9301, 'private', 'visible'),
  (9512, 9312, 9301, 'public', 'visible'),
  (9515, 9315, 9302, 'public', 'visible'),
  (9516, 9316, 9302, 'private', 'visible'),
  (9517, 9317, 9301, 'private', 'visible'),
  (9518, 9318, 9301, 'public', 'hidden'),
  (9523, 9323, 9301, 'public', 'visible'),
  (9524, 9323, 9301, 'private', 'visible'),
  (9525, 9323, 9301, 'private', 'hidden'),
  (9526, 9323, 9302, 'public', 'visible'),
  (9527, 9323, 9302, 'private', 'visible'),
  (9528, 9323, 9302, 'public', 'hidden')
) fixture(number, annotation_number, reader_number, visibility, moderation_status);
update public.annotation_comments set parent_comment_id = '00000000-0000-4000-9000-000000009526'
where id = '00000000-0000-4000-9000-000000009524';
insert into public.annotation_comment_likes(comment_id, user_id) values
 ('00000000-0000-4000-9000-000000009523', '00000000-0000-4000-9000-000000009301'),
 ('00000000-0000-4000-9000-000000009523', '00000000-0000-4000-9000-000000009302');

create temporary table book_notes_result as select public.get_my_book_annotations('notes-book') as threads;
select extensions.is((select jsonb_agg(thread->>'id' order by position)
  from book_notes_result, jsonb_array_elements(threads) with ordinality item(thread, position)),
 ' ["00000000-0000-4000-9000-000000009310","00000000-0000-4000-9000-000000009311","00000000-0000-4000-9000-000000009312","00000000-0000-4000-9000-000000009323"]'::jsonb,
 'only owned book marks or visible thoughts are included, ordered by UUID rather than creation date');
select extensions.is((select threads #>> '{0,underlinedByMe}' from book_notes_result), 'true', 'a mark on another reader’s shared anchor belongs to me');
select extensions.is((select threads #>> '{1,underlinedByMe}' from book_notes_result), 'false', 'a private thought is returned even without a mark');
select extensions.is((select threads #>> '{1,comments,0,visibility}' from book_notes_result), 'private', 'the owner retains private thought visibility');
select extensions.is((select threads #>> '{1,publiclyVisible}' from book_notes_result), 'false', 'private-only thoughts do not become public');
select extensions.is((select (threads->3) - 'comments' from book_notes_result),
 private.annotation_snapshot('00000000-0000-4000-9000-000000009323') - 'comments', 'thread fields keep the shared snapshot contract');
select extensions.is((select jsonb_agg(comment->>'id' order by position)
  from book_notes_result, jsonb_array_elements(threads #> '{3,comments}') with ordinality item(comment, position)),
 '["00000000-0000-4000-9000-000000009523","00000000-0000-4000-9000-000000009524"]'::jsonb,
 'comments contain only my visible public and private thoughts, never other readers or moderated comments');
select extensions.is((select threads #>> '{3,comments,0,likeCount}' from book_notes_result), '2', 'own public thoughts retain reaction totals and ranking');
select extensions.is((select threads #>> '{3,comments,0,likedByMe}' from book_notes_result), 'true', 'own reaction state is preserved');
select extensions.is((select threads #>> '{3,comments,1,parentCommentId}' from book_notes_result), '00000000-0000-4000-9000-000000009526', 'reply anchors survive without exposing the parent comment body');
select extensions.is((select threads #> '{0,comments}' from book_notes_result), '[]'::jsonb, 'an underline without thoughts has an empty comments array');
select extensions.is(public.get_my_book_annotations('missing-book'), '[]'::jsonb, 'an empty book returns an array immediately');
select extensions.is(public.get_my_book_annotations('another-book') #>> '{0,id}', '00000000-0000-4000-9000-000000009319', 'a book request selects its own content ID');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009303', true);
select extensions.is(public.get_my_book_annotations('notes-book'), '[]'::jsonb, 'a reader without notes gets no public threads from other readers');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009302', true);
select extensions.ok(not exists (select 1 from jsonb_array_elements(public.get_my_book_annotations('notes-book')) thread
  where thread->>'id' = '00000000-0000-4000-9000-000000009311'), 'the original anchor author cannot see another reader’s private-only thought');
select extensions.ok((select bool_and(comment->>'authorId' = '00000000-0000-4000-9000-000000009302')
  from jsonb_array_elements(public.get_my_book_annotations('notes-book')) thread,
  jsonb_array_elements(thread->'comments') comment), 'switching accounts returns only the new account’s thoughts');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009301', true);

create temporary table book_notes_pages as
select public.get_my_book_annotations('notes-book', null, 2) as first_page,
  public.get_my_book_annotations('notes-book', '00000000-0000-4000-9000-000000009311', 2) as second_page;
select extensions.is((select first_page || second_page from book_notes_pages), (select threads from book_notes_result), 'adjacent pages contain every owned thread exactly once');
select extensions.is(public.get_my_book_annotations('notes-book', '00000000-0000-4000-9000-000000009323', 2), '[]'::jsonb, 'the page after the final ID is an empty array');
select extensions.is(jsonb_array_length(public.get_my_book_annotations('notes-book', '00000000-0000-4000-9000-000000009312', 2)), 1, 'the final partial page contains only remaining rows');
select extensions.is(public.get_my_book_annotations('notes-book', '00000000-0000-4000-9000-000000009313', 1) #>> '{0,id}',
 '00000000-0000-4000-9000-000000009323', 'a keyset cursor does not need to reference a surviving row');

insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key)
select ('00000000-0000-4000-9000-' || lpad((10000 + number)::text, 12, '0'))::uuid,
  'book', 'many-notes-book', 'chapter-' || number, '长书', '00000000-0000-4000-9000-000000009301'::uuid,
  '原文 ' || number, repeat(md5(number::text), 2)
from generate_series(1, 103) number;
insert into public.content_annotation_marks(annotation_id, user_id)
select id, '00000000-0000-4000-9000-000000009301'::uuid
from public.content_annotations where content_id = 'many-notes-book';
select extensions.is(jsonb_array_length(public.get_my_book_annotations('many-notes-book')), 100, 'the default page is bounded to 100 threads');
select extensions.is(jsonb_array_length(public.get_my_book_annotations('many-notes-book', '00000000-0000-4000-9000-000000010100')), 3, 'the second default page returns the remaining threads');
select extensions.is(public.get_my_book_annotations('many-notes-book', '00000000-0000-4000-9000-000000010103'), '[]'::jsonb, 'the last default page terminates cleanly');
set local role authenticated;
select extensions.is(jsonb_array_length(public.get_my_book_annotations('notes-book', null, 1)), 1, 'authenticated callers can read through the definer RPC without table access');
reset role;

select * from extensions.finish();
rollback;
