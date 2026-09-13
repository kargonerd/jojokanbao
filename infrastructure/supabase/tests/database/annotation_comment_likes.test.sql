begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(18);
set local session_replication_role = replica;
insert into auth.users(id, email) values
 ('00000000-0000-4000-9000-000000009001', 'likes-author@example.invalid'),
 ('00000000-0000-4000-9000-000000009002', 'likes-reader@example.invalid');
set local session_replication_role = origin;
insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key)
values ('00000000-0000-4000-9000-000000009100', 'book', 'likes-book', 'chapter', '书', '00000000-0000-4000-9000-000000009001', '原文', repeat('a', 64));
insert into public.annotation_comments(id, annotation_id, user_id, body, visibility, moderation_status, created_at) values
 ('00000000-0000-4000-9000-000000009111', '00000000-0000-4000-9000-000000009100', '00000000-0000-4000-9000-000000009001', '早想法', 'public', 'visible', '2026-08-01'),
 ('00000000-0000-4000-9000-000000009112', '00000000-0000-4000-9000-000000009100', '00000000-0000-4000-9000-000000009001', '热门回复', 'public', 'visible', '2026-08-02'),
 ('00000000-0000-4000-9000-000000009113', '00000000-0000-4000-9000-000000009100', '00000000-0000-4000-9000-000000009001', '私密想法', 'private', 'visible', '2026-08-03'),
 ('00000000-0000-4000-9000-000000009114', '00000000-0000-4000-9000-000000009100', '00000000-0000-4000-9000-000000009001', '隐藏想法', 'public', 'hidden', '2026-08-04');
update public.annotation_comments set parent_comment_id = '00000000-0000-4000-9000-000000009111' where id = '00000000-0000-4000-9000-000000009112';

select extensions.ok(not has_function_privilege('anon', 'public.set_annotation_comment_like(uuid,boolean)', 'execute'), 'anonymous callers cannot like');
select extensions.ok(not has_table_privilege('authenticated', 'public.annotation_comment_likes', 'INSERT'), 'readers cannot bypass visibility checks');
select extensions.ok(not has_table_privilege('authenticated', 'public.annotation_comment_likes', 'SELECT'), 'liking account identities remain private');
select set_config('request.jwt.claim.sub', '', true);
select extensions.throws_ok($$select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', true)$$,
 '42501', 'Authentication is required', 'missing authentication fails closed');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009001', true);
select extensions.is(public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', true)->>'likeCount', '1', 'public thoughts and replies can be liked');
select extensions.is(public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', true)->>'likeCount', '1', 'retrying a like is idempotent');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009002', true);
select extensions.is(public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', true)->>'likeCount', '2', 'different accounts contribute one like each');
select extensions.is(public.get_annotation_threads('book', 'likes-book', 'chapter') #>> '{0,comments,0,id}', '00000000-0000-4000-9000-000000009112', 'popular replies sort before older unliked thoughts');
select extensions.is(public.get_annotation_threads('book', 'likes-book', 'chapter') #>> '{0,comments,0,likedByMe}', 'true', 'snapshots include the current reader reaction');
select extensions.is(jsonb_array_length(public.get_annotation_threads('book', 'likes-book', 'chapter') #> '{0,comments}'), 2, 'ranking does not expose private or moderated comments');
select extensions.is(public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', false)->>'likeCount', '1', 'unlike removes only the current reader reaction');
select extensions.is(public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', false)->>'likeCount', '1', 'retrying unlike does not decrement another account');
select extensions.throws_ok($$select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009113', true)$$,
 'P0002', 'Public comment not found', 'private thoughts cannot be liked');
select extensions.throws_ok($$select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009114', true)$$,
 'P0002', 'Public comment not found', 'moderated comments cannot be liked');
update public.content_annotations set moderation_status = 'hidden' where id = '00000000-0000-4000-9000-000000009100';
select extensions.throws_ok($$select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', true)$$,
 'P0002', 'Public comment not found', 'moderated annotations cannot receive likes');
update public.content_annotations set moderation_status = 'visible' where id = '00000000-0000-4000-9000-000000009100';
select extensions.throws_ok($$select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', null)$$,
 '22023', 'Like state is required', 'null does not silently unlike');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000009001', true);
select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', false);
select extensions.is(public.get_annotation_threads('book', 'likes-book', 'chapter') #>> '{0,comments,0,id}', '00000000-0000-4000-9000-000000009111', 'equal counts retain chronological order');
select public.set_annotation_comment_like('00000000-0000-4000-9000-000000009112', true);
delete from public.annotation_comments where id = '00000000-0000-4000-9000-000000009112';
select extensions.is((select count(*)::integer from public.annotation_comment_likes where comment_id = '00000000-0000-4000-9000-000000009112'), 0, 'deleting a comment cascades its reactions');
select * from extensions.finish();
rollback;
