begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

select extensions.hasnt_table(
  'private',
  'annotation_moderation_events',
  'annotation moderation does not keep an unused event table'
);

create temporary table annotation_test_state (
  author_id uuid not null default extensions.gen_random_uuid(),
  commenter_id uuid not null default extensions.gen_random_uuid(),
  reporter_id uuid not null default extensions.gen_random_uuid(),
  pager_id uuid not null default extensions.gen_random_uuid(),
  annotation_id uuid,
  comment_id uuid,
  report_id uuid
);
insert into annotation_test_state default values;

set local session_replication_role = replica;
insert into auth.users(id, email, raw_user_meta_data)
select author_id, 'annotation-author@example.invalid', '{}'::jsonb from annotation_test_state
union all
select commenter_id, 'annotation-commenter@example.invalid', '{}'::jsonb from annotation_test_state
union all
select reporter_id, 'annotation-reporter@example.invalid', '{}'::jsonb from annotation_test_state
union all
select pager_id, 'annotation-pager@example.invalid', '{}'::jsonb from annotation_test_state;
set local session_replication_role = origin;

insert into public.profiles(id, display_name)
select author_id, '测试甲-ABC' from annotation_test_state
union all
select commenter_id, '测试乙-DEF' from annotation_test_state
union all
select reporter_id, '测试丙-GHJ' from annotation_test_state
union all
select pager_id, '测试丁-KLM' from annotation_test_state;

insert into private.feature_flag_operator_secret(singleton, token_digest)
values (true, extensions.digest(repeat('o', 32), 'sha256'))
on conflict (singleton) do update set token_digest = excluded.token_digest;

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select author_id::text from annotation_test_state),
    true
  );
end;
$$;

select extensions.throws_ok(
  $$select public.create_content_annotation(
    'book', 'book-1', 'chapter-unsafe', '测试书', E'/\\evil.example',
    '不安全路径', '', '', 0, 5, null
  )$$,
  '22023',
  'Annotation target must be a local path',
  'annotation targets reject backslash-obfuscated external paths'
);

update annotation_test_state
set annotation_id = (
  public.create_content_annotation(
    'book', 'book-1', 'chapter-1', '测试书 · 第一章', '/book/book-1?chapter=chapter-1',
    '被划线的原文', '', '', 0, 7, null
  )->>'id'
)::uuid;

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select commenter_id::text from annotation_test_state),
    true
  );
end;
$$;

update annotation_test_state
set comment_id = (
  public.add_annotation_comment(annotation_id, '第一条评论', null)->>'id'
)::uuid;

select extensions.is(
  (
    select count(*)::integer
    from public.user_notifications notification, annotation_test_state state
    where notification.recipient_id = state.author_id
      and notification.kind = 'annotation.comment'
  ),
  1,
  'a new discussion comment notifies the annotation author'
);

select extensions.is(
  (
    select body
    from public.user_notifications notification, annotation_test_state state
    where notification.recipient_id = state.author_id
      and notification.kind = 'annotation.comment'
  ),
  '第一条评论',
  'the comment notification contains the submitted plain text'
);

select extensions.throws_ok(
  $$select public.report_annotation_comment(
    (select comment_id from annotation_test_state),
    'spam',
    null
  )$$,
  '22023',
  'You cannot report your own comment',
  'a reader cannot report their own comment through the RPC'
);

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select reporter_id::text from annotation_test_state),
    true
  );
end;
$$;

update annotation_test_state
set report_id = (
  public.report_annotation_comment(comment_id, 'abuse', '测试举报')->>'id'
)::uuid;

select extensions.is(
  public.operator_moderate_annotation_comment(
    repeat('o', 32),
    (select comment_id from annotation_test_state),
    'hide',
    '确认违反讨论规则'
  )->>'success',
  'true',
  'an operator can hide a reported comment'
);

select extensions.is(
  (
    select moderation_status
    from public.annotation_comments comment, annotation_test_state state
    where comment.id = state.comment_id
  ),
  'hidden',
  'moderation hides the reported comment'
);

select extensions.is(
  (
    select status
    from public.annotation_comment_reports report, annotation_test_state state
    where report.id = state.report_id
  ),
  'resolved',
  'moderation resolves the pending report'
);

select extensions.is(
  (
    select count(*)::integer
    from public.user_notifications notification, annotation_test_state state
    where notification.recipient_id = state.reporter_id
      and notification.kind = 'moderation.report_resolved'
      and notification.resource_id = state.report_id::text
  ),
  1,
  'moderation writes a real notification for the affected reporter'
);

select extensions.like(
  (
    select target_path
    from public.user_notifications notification, annotation_test_state state
    where notification.recipient_id = state.reporter_id
      and notification.kind = 'moderation.report_resolved'
  ),
  '%discussion=%',
  'the moderation notification links back to the discussion'
);

insert into public.user_notifications(
  id, recipient_id, kind, title, event_key, created_at
)
select '30000000-0000-4000-8000-000000000003', pager_id, 'test.cursor', '三', 'cursor-3', '2026-08-19 00:00:00+00' from annotation_test_state
union all
select '30000000-0000-4000-8000-000000000002', pager_id, 'test.cursor', '二', 'cursor-2', '2026-08-19 00:00:00+00' from annotation_test_state
union all
select '30000000-0000-4000-8000-000000000001', pager_id, 'test.cursor', '一', 'cursor-1', '2026-08-19 00:00:00+00' from annotation_test_state;

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select pager_id::text from annotation_test_state),
    true
  );
end;
$$;

select extensions.is(
  jsonb_array_length(public.get_my_notifications(2, null, null)),
  2,
  'the first notification page respects its limit'
);

select extensions.is(
  public.get_my_notifications(2, null, null)->1->>'id',
  '30000000-0000-4000-8000-000000000002',
  'equal timestamps use the notification id as a stable tiebreaker'
);

select extensions.is(
  public.get_my_notifications(
    2,
    '2026-08-19 00:00:00+00',
    '30000000-0000-4000-8000-000000000002'
  )->0->>'id',
  '30000000-0000-4000-8000-000000000001',
  'the compound cursor does not skip an equal-timestamp notification'
);

select extensions.throws_ok(
  $$select public.get_my_notifications(2, '2026-08-19 00:00:00+00', null)$$,
  '22023',
  'Notification cursor is incomplete',
  'notification pagination rejects a partial cursor'
);

select * from extensions.finish();
rollback;
