begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(34);

select extensions.has_table('public', 'anchor_items', 'anchored notes and links share one table');
select extensions.has_function('public', 'create_anchor_item',
  array['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'integer', 'integer', 'jsonb', 'text'],
  'anchored content is created through one RPC');

select extensions.ok(has_function_privilege('authenticated', 'public.get_anchor_items(text,text,text)', 'execute'), 'authenticated readers may load anchored content');
select extensions.ok(not has_function_privilege('anon', 'public.get_anchor_items(text,text,text)', 'execute'), 'anonymous callers cannot execute the RPC');
select extensions.ok(not has_function_privilege('authenticated', 'public.admin_review_anchor_item(uuid,uuid,text,text)', 'execute'), 'review RPC is not executable by readers');
select extensions.ok(has_function_privilege('service_role', 'public.admin_review_anchor_item(uuid,uuid,text,text)', 'execute'), 'review RPC is reserved for the service key');
select extensions.is(public.get_reader_runtime_contract(), '202610060002', 'the reader runtime contract pins the anchored content migration');

create temporary table anchor_test_state (
  reader_id uuid not null default extensions.gen_random_uuid(),
  other_id uuid not null default extensions.gen_random_uuid(),
  editor_id uuid not null default extensions.gen_random_uuid(),
  first_item_id uuid,
  pending_item_id uuid
);
insert into anchor_test_state default values;

set local session_replication_role = replica;
insert into auth.users(id, email)
select reader_id, 'anchor-reader@example.invalid' from anchor_test_state
union all
select other_id, 'anchor-other@example.invalid' from anchor_test_state
union all
select editor_id, 'anchor-editor@example.invalid' from anchor_test_state;
set local session_replication_role = origin;

insert into public.profiles(id, display_name)
select reader_id, '读者甲' from anchor_test_state
union all
select other_id, '读者乙' from anchor_test_state
union all
select editor_id, 'JOJO 编辑部' from anchor_test_state;

-- Anonymous callers are rejected before anything else.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select extensions.throws_ok(
  $$select public.get_anchor_items('book', 'anchor-book', 'chapter-1')$$,
  '42501', 'Authentication is required', 'anchored content requires authentication'
);

-- A regular reader creates a pending sentence note.
select set_config('request.jwt.claim.sub', (select reader_id::text from anchor_test_state), true);
select set_config('request.jwt.claims',
  (select jsonb_build_object('sub', reader_id::text, 'role', 'authenticated')::text from anchor_test_state), true);

select extensions.is(
  (select public.create_anchor_item(
    'book', 'anchor-book', 'chapter-1', '测试书 · 第一章', '/book/anchor-book?chapter=chapter-1',
    'sentence', 'note', 'annotation', null, null,
    '被批注的原文', '', '', 0, 5,
    jsonb_build_object('body', '这一句是全书的核心论点。'), null
  )->>'status'),
  'pending', 'reader submissions enter the review queue'
);
update anchor_test_state
  set first_item_id = (select (public.get_anchor_items('book', 'anchor-book', 'chapter-1') -> 0 ->> 'id')::uuid);

select extensions.is(
  (select jsonb_array_length(public.get_anchor_items('book', 'anchor-book', 'chapter-1'))),
  1, 'readers see their own pending submissions'
);

-- Another reader sees nothing until approval.
select set_config('request.jwt.claim.sub', (select other_id::text from anchor_test_state), true);
select set_config('request.jwt.claims',
  (select jsonb_build_object('sub', other_id::text, 'role', 'authenticated')::text from anchor_test_state), true);
select extensions.is(
  (select jsonb_array_length(public.get_anchor_items('book', 'anchor-book', 'chapter-1'))),
  0, 'pending submissions stay invisible to other readers'
);

-- An editorial account publishes immediately and keeps its badge key.
select set_config('request.jwt.claim.sub', (select editor_id::text from anchor_test_state), true);
select set_config('request.jwt.claims',
  (select jsonb_build_object('sub', editor_id::text, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('jojo_roles', jsonb_build_array('editorial')))::text from anchor_test_state), true);

select extensions.is(
  (select public.create_anchor_item(
    'book', 'anchor-book', 'chapter-1', '测试书 · 第一章', '/book/anchor-book?chapter=chapter-1',
    'sentence', 'note', 'annotation', null, null,
    '被批注的原文', '', '', 0, 5,
    jsonb_build_object('body', '阳老师的批注。'), 'yang-review'
  )->>'status'),
  'approved', 'editorial accounts publish directly'
);

-- A regular reader cannot claim an official badge key.
select set_config('request.jwt.claim.sub', (select reader_id::text from anchor_test_state), true);
select set_config('request.jwt.claims',
  (select jsonb_build_object('sub', reader_id::text, 'role', 'authenticated')::text from anchor_test_state), true);
select extensions.ok(
  (select public.create_anchor_item(
    'book', 'anchor-book', 'chapter-1', '测试书 · 第一章', '/book/anchor-book?chapter=chapter-1',
    'sentence', 'note', 'annotation', null, null,
    '读者仿冒官方', '', '', 10, 16,
    jsonb_build_object('body', '伪装官方批注。'), 'yang-review'
  ) ->> 'authorKey') is null,
  'regular readers cannot claim an official badge key'
);

select set_config('request.jwt.claim.sub', (select other_id::text from anchor_test_state), true);
select set_config('request.jwt.claims',
  (select jsonb_build_object('sub', other_id::text, 'role', 'authenticated')::text from anchor_test_state), true);
select extensions.is(
  (select jsonb_array_length(public.get_anchor_items('book', 'anchor-book', 'chapter-1'))),
  1, 'approved editorial content is public'
);

-- Input validation.
select set_config('request.jwt.claim.sub', (select reader_id::text from anchor_test_state), true);
select set_config('request.jwt.claims',
  (select jsonb_build_object('sub', reader_id::text, 'role', 'authenticated')::text from anchor_test_state), true);

select extensions.throws_ok(
  $$select public.create_anchor_item('book', 'anchor-book', 'chapter-1', '测试书', null,
    'sentence', 'note', 'annotation', null, null, '原文', '', '', 0, 5,
    jsonb_build_object('body', ''), null)$$,
  '22023', 'Note body is required (1-8000 characters)', 'note payloads require a body'
);
select extensions.throws_ok(
  $$select public.create_anchor_item('book', 'anchor-book', 'chapter-1', '测试书', null,
    'sentence', 'link', 'external', null, null, '原文', '', '', 0, 5,
    jsonb_build_object('ref', jsonb_build_object('contentId', 'books:other'), 'url', 'https://example.invalid'), null)$$,
  '22023', 'Link payload requires exactly one of ref or url', 'link payloads take exactly one target'
);
select extensions.throws_ok(
  $$select public.create_anchor_item('book', 'anchor-book', 'chapter-1', '测试书', null,
    'sentence', 'note', 'annotation', null, null, '原文', '', '', null, null,
    jsonb_build_object('body', '缺偏移。'), null)$$,
  '22023', 'Sentence anchors require valid offsets', 'sentence anchors require offsets'
);
select extensions.throws_ok(
  $$select public.create_anchor_item('book', 'anchor-book', 'chapter-1', '测试书', null,
    'work', 'note', 'preface', null, null, null, '', '', null, null,
    jsonb_build_object('body', '作品级不能带节。'), null)$$,
  '22023', 'Anchor level and section do not match', 'work-level anchors must not carry a section'
);
select extensions.throws_ok(
  $$select public.create_anchor_item('book', 'anchor-book', null, '测试书', null,
    'appendix', 'note', 'preface', null, null, null, '', '', null, null,
    jsonb_build_object('body', '未知层级。'), null)$$,
  '22023', 'Unknown anchor level', 'anchor levels are a closed set'
);
select extensions.throws_ok(
  $$select public.create_anchor_item('book', 'anchor-book', 'chapter-1', '测试书', null,
    'paragraph', 'note', 'gloss', null, null, null, '', '', null, null,
    jsonb_build_object('body', '段批缺块 id。'), null)$$,
  '22023', 'Paragraph anchors require a block id', 'paragraph anchors require a block id'
);

-- Moderation: approve the reader submission, then audit and notification exist.
update anchor_test_state
  set pending_item_id = (select (public.create_anchor_item(
    'book', 'anchor-book', 'chapter-1', '测试书 · 第一章', '/book/anchor-book?chapter=chapter-1',
    'sentence', 'link', 'external', '一部在线词典', null,
    '被链接的原文', '', '', 20, 26,
    jsonb_build_object('url', 'https://dictionary.example.invalid/term'), null
  ) ->> 'id')::uuid);

select extensions.is(
  (select public.admin_review_anchor_item(
    (select editor_id from anchor_test_state),
    (select pending_item_id from anchor_test_state),
    'approve', '外链内容合适'
  )->>'status'),
  'approved', 'moderators approve pending submissions'
);
select extensions.ok(
  exists (select 1 from private.admin_actions where action = 'anchor.approve' and target_id = (select pending_item_id from anchor_test_state)),
  'approval decisions are audited'
);
select extensions.ok(
  exists (
    select 1 from public.user_notifications notification
    where notification.kind = 'anchor.review'
      and notification.recipient_id = (select reader_id from anchor_test_state)
      and notification.payload ->> 'action' = 'approve'
  ),
  'submitters are notified about approvals'
);

-- Rejection keeps the item hidden and notifies the submitter.
update anchor_test_state
  set pending_item_id = (select (public.create_anchor_item(
    'book', 'anchor-book', 'chapter-1', '测试书 · 第一章', '/book/anchor-book?chapter=chapter-1',
    'sentence', 'link', 'external', '推广链接', null,
    '被链接的原文', '', '', 30, 34,
    jsonb_build_object('url', 'https://promo.example.invalid'), null
  ) ->> 'id')::uuid);
select extensions.is(
  (select public.admin_review_anchor_item(
    (select editor_id from anchor_test_state),
    (select pending_item_id from anchor_test_state),
    'reject', '纯推广链接不符合外链规范'
  )->>'status'),
  'rejected', 'moderators reject submissions with a reason'
);
select extensions.ok(
  exists (
    select 1 from public.user_notifications notification
    where notification.kind = 'anchor.review'
      and notification.recipient_id = (select reader_id from anchor_test_state)
      and notification.payload ->> 'action' = 'reject'
  ),
  'submitters are notified about rejections'
);

-- Submitters may delete pending items but not published ones.
update anchor_test_state
  set pending_item_id = (select (public.create_anchor_item(
    'book', 'anchor-book', 'chapter-1', '测试书 · 第一章', '/book/anchor-book?chapter=chapter-1',
    'section', 'note', 'gloss', '章级注', null,
    null, '', '', null, null,
    jsonb_build_object('body', '本章的背景说明。'), null
  ) ->> 'id')::uuid);
select extensions.is(
  (select public.delete_my_anchor_item((select pending_item_id from anchor_test_state)) ->> 'deleted'),
  'true', 'submitters may withdraw pending items'
);
-- Publishing the reader's own sentence note removes the withdrawal option.
select extensions.is(
  (select public.admin_review_anchor_item(
    (select editor_id from anchor_test_state),
    (select first_item_id from anchor_test_state),
    'approve', '批注质量合格'
  )->>'status'),
  'approved', 'reader notes become visible after approval'
);
select extensions.throws_ok(
  $$select public.delete_my_anchor_item((select first_item_id from anchor_test_state))$$,
  '22023', 'Only pending items can be deleted', 'published items cannot be withdrawn by their submitter'
);

-- The editing workbench can repair an anchor and the anchor key is recomputed.
select extensions.is(
  (select public.admin_update_anchor_item(
    (select editor_id from anchor_test_state),
    (select first_item_id from anchor_test_state),
    jsonb_build_object('quote', '修订后的原文', 'startOffset', 1, 'endOffset', 7),
    '修正锚点文本'
  ) ->> 'anchorKey'),
  (select encode(extensions.digest(
    jsonb_build_array('修订后的原文', '', '', 1, 7)::text, 'sha256'
  ), 'hex')),
  'anchor repairs recompute the discussion aggregation key'
);
select extensions.ok(
  exists (select 1 from private.admin_actions where action = 'anchor.update'),
  'anchor repairs are audited'
);

-- Seed import is idempotent per seedKey.
select extensions.is(
  (select public.admin_upsert_seed_anchor_items(
    (select editor_id from anchor_test_state),
    jsonb_build_array(jsonb_build_object(
      'seedKey', 'seed-1',
      'contentType', 'book', 'contentId', 'anchor-book',
      'sectionId', 'chapter-1', 'contentTitle', '测试书 · 第一章',
      'contentUrl', '/book/anchor-book?chapter=chapter-1',
      'level', 'paragraph', 'kind', 'note', 'type', 'gloss',
      'itemId', 'jojo-search-block:chapter-1:3',
      'payload', jsonb_build_object('body', '灌库的段批。'),
      'createdBy', (select editor_id::text from anchor_test_state)
    ))
  ) ->> 'inserted'),
  '1', 'seed imports report fresh rows'
);
select extensions.is(
  (select public.admin_upsert_seed_anchor_items(
    (select editor_id from anchor_test_state),
    jsonb_build_array(jsonb_build_object(
      'seedKey', 'seed-1',
      'contentType', 'book', 'contentId', 'anchor-book',
      'sectionId', 'chapter-1', 'contentTitle', '测试书 · 第一章',
      'contentUrl', '/book/anchor-book?chapter=chapter-1',
      'level', 'paragraph', 'kind', 'note', 'type', 'gloss',
      'itemId', 'jojo-search-block:chapter-1:3',
      'payload', jsonb_build_object('body', '灌库的段批（修订）。'),
      'createdBy', (select editor_id::text from anchor_test_state)
    ))
  ) ->> 'updated'),
  '1', 're-seeding updates the existing row'
);
select extensions.is(
  (select count(*) from public.anchor_items where seed_key = 'seed-1')::text,
  '1', 'seed keys stay unique'
);
select extensions.is(
  (select jsonb_array_length(public.admin_export_anchor_snapshot('anchor-book') -> 'notes')),
  3, 'EPUB snapshots export approved notes only'
);

rollback;
