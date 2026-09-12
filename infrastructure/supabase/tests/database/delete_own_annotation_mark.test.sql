begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(16);
set local session_replication_role = replica;
insert into auth.users(id, email) values
 ('00000000-0000-4000-9000-000000009201', 'mark-owner@example.invalid'),
 ('00000000-0000-4000-9000-000000009202', 'mark-reader@example.invalid');
set local session_replication_role = origin;
update private.feature_flags set config = config || '{"publicMarkThreshold": 2}'::jsonb where key = 'reader.annotations';
insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key)
values ('00000000-0000-4000-9000-000000009210', 'book', 'delete-mark-book', 'chapter', '书', '00000000-0000-4000-9000-000000009201', '原文', repeat('b', 64));
insert into public.content_annotation_marks(annotation_id, user_id) values
 ('00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009201'),
 ('00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009202');
insert into public.annotation_comments(id, annotation_id, user_id, body, visibility) values
 ('00000000-0000-4000-9000-000000009211', '00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009201', '私密想法', 'private');

select extensions.ok(not has_function_privilege('anon', 'public.delete_my_annotation_mark(uuid)', 'execute'), 'anonymous callers cannot delete marks');
select extensions.ok(not has_table_privilege('authenticated', 'public.content_annotation_marks', 'DELETE'), 'readers cannot delete arbitrary marks directly');
select set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok($$select public.delete_my_annotation_mark('00000000-0000-4000-9000-000000009210')$$,
 '42501', 'Authentication is required', 'authentication is required');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009201', true);
select extensions.is(public.delete_my_annotation_mark('00000000-0000-4000-9000-000000009210')->'thread', 'null'::jsonb, 'removing my mark hides an anchor below the sharing threshold');
select extensions.is((select count(*)::integer from public.content_annotation_marks where user_id = '00000000-0000-4000-9000-000000009201'), 0, 'only my membership is removed');
select extensions.is((select count(*)::integer from public.content_annotation_marks where user_id = '00000000-0000-4000-9000-000000009202'), 1, 'another reader retains their mark');
select extensions.is((select count(*)::integer from public.annotation_comments where id = '00000000-0000-4000-9000-000000009211'), 1, 'private thoughts are preserved');
select extensions.is(jsonb_array_length(public.get_annotation_threads('book', 'delete-mark-book', 'chapter')), 0, 'subsequent loads agree with the deletion result');
select public.delete_my_annotation_mark('00000000-0000-4000-9000-000000009210');
select extensions.is((select count(*)::integer from public.content_annotation_marks where annotation_id = '00000000-0000-4000-9000-000000009210'), 1, 'retrying cannot remove somebody else’s membership');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009202', true);
select extensions.is(public.get_annotation_threads('book', 'delete-mark-book', 'chapter') #>> '{0,underlinedByMe}', 'true', 'the other reader still sees their own underline');
insert into public.annotation_comments(id, annotation_id, user_id, body, visibility) values
 ('00000000-0000-4000-9000-000000009212', '00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009202', '公开想法', 'public');
select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009212', true);
select extensions.is(public.delete_my_annotation_mark('00000000-0000-4000-9000-000000009210') #>> '{thread,underlineCount}', '0', 'public thoughts survive removal of the final underline with a zero count');
select extensions.is(public.get_annotation_threads('book', 'delete-mark-book', 'chapter') #>> '{0,underlinedByMe}', 'false', 'deleted marks stay removed on reload');
select extensions.is(public.get_annotation_threads('book', 'delete-mark-book', 'chapter') #>> '{0,comments,0,likeCount}', '1', 'deletion preserves public thoughts and their likes');
select extensions.is(jsonb_array_length(public.get_annotation_threads('book', 'delete-mark-book', 'chapter') #> '{0,comments}'), 1, 'deletion does not expose another reader’s private thought');
select extensions.is(public.delete_my_annotation_mark('00000000-0000-4000-9000-000000009210') #>> '{thread,underlinedByMe}', 'false', 'retrying a deletion returns the current shared state');
select extensions.is(public.delete_my_annotation_mark('00000000-0000-4000-9000-000000009299')->'thread', 'null'::jsonb, 'deleting a missing anchor is harmless');
select * from extensions.finish();
rollback;
