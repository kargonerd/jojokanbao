begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(13);
set local session_replication_role = replica;
insert into auth.users(id, email) values
 ('00000000-0000-4000-9000-000000009201', 'comment-owner@example.invalid'),
 ('00000000-0000-4000-9000-000000009202', 'comment-reader@example.invalid');
set local session_replication_role = origin;
update private.feature_flags set config = config || '{"publicMarkThreshold": 2}'::jsonb where key = 'reader.annotations';
insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key)
values ('00000000-0000-4000-9000-000000009210', 'book', 'delete-comment-book', 'chapter', '书', '00000000-0000-4000-9000-000000009201', '原文', repeat('b', 64));
insert into public.content_annotation_marks(annotation_id, user_id) values
 ('00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009201');
insert into public.annotation_comments(id, annotation_id, user_id, body, visibility) values
 ('00000000-0000-4000-9000-000000009211', '00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009201', '私密想法', 'private'),
 ('00000000-0000-4000-9000-000000009212', '00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009201', '公开想法', 'public'),
 ('00000000-0000-4000-9000-000000009213', '00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009202', '读者公开想法', 'public');
insert into public.annotation_comments(id, annotation_id, parent_comment_id, user_id, body, visibility) values
 ('00000000-0000-4000-9000-000000009214', '00000000-0000-4000-9000-000000009210', '00000000-0000-4000-9000-000000009212', '00000000-0000-4000-9000-000000009202', '回复', 'public');

select extensions.ok(not has_function_privilege('anon', 'public.delete_my_annotation_comment(uuid)', 'execute'), 'anonymous callers cannot delete comments');
select extensions.ok(not has_table_privilege('authenticated', 'public.annotation_comments', 'DELETE'), 'readers cannot delete arbitrary comments directly');

-- 1. Authentication is required
select set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok($$select public.delete_my_annotation_comment('00000000-0000-4000-9000-000000009211')$$,
 '42501', 'Authentication is required', 'authentication is required');

-- 2. Owner can delete private thought
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009201', true);
select extensions.is(public.delete_my_annotation_comment('00000000-0000-4000-9000-000000009211')->>'commentId', '00000000-0000-4000-9000-000000009211', 'returns deleted comment id');
select extensions.is((select count(*)::integer from public.annotation_comments where id = '00000000-0000-4000-9000-000000009211'), 0, 'private thought is deleted');

-- 3. Cannot delete someone else's comment
select extensions.is(public.delete_my_annotation_comment('00000000-0000-4000-9000-000000009213')->'thread', 'null'::jsonb, 'cannot delete other reader comment');
select extensions.is((select count(*)::integer from public.annotation_comments where id = '00000000-0000-4000-9000-000000009213'), 1, 'other reader comment is retained');

-- 4. Delete public thought with reply and like
select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009212', true);
select extensions.is((select count(*)::integer from public.annotation_comment_likes where comment_id = '00000000-0000-4000-9000-000000009212'), 1, 'like exists before deletion');
select extensions.is(public.delete_my_annotation_comment('00000000-0000-4000-9000-000000009212')->>'commentId', '00000000-0000-4000-9000-000000009212', 'deletes public thought');
select extensions.is((select count(*)::integer from public.annotation_comment_likes where comment_id = '00000000-0000-4000-9000-000000009212'), 0, 'likes are cascaded');
select extensions.is((select parent_comment_id from public.annotation_comments where id = '00000000-0000-4000-9000-000000009214'), null, 'replies have parent set to null');

-- 5. Retrying is harmless
select extensions.is(public.delete_my_annotation_comment('00000000-0000-4000-9000-000000009212')->'thread', 'null'::jsonb, 'retrying deleted comment is harmless');
select extensions.is(public.delete_my_annotation_comment('00000000-0000-4000-9000-000000009299')->'thread', 'null'::jsonb, 'deleting nonexistent comment is harmless');

select * from extensions.finish();
rollback;
