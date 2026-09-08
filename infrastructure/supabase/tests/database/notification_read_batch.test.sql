begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(21);

select extensions.has_function('public', 'mark_my_notifications_read', array['uuid[]'], 'explicit notification batch RPC exists');
select extensions.ok(has_function_privilege('authenticated', 'public.mark_my_notifications_read(uuid[])', 'execute'), 'authenticated readers can mark explicit IDs');
select extensions.ok(not has_function_privilege('anon', 'public.mark_my_notifications_read(uuid[])', 'execute'), 'anonymous callers cannot execute the batch RPC');
select extensions.ok(not has_table_privilege('authenticated', 'public.user_notifications', 'UPDATE'), 'readers cannot bypass the RPC to update notification rows');

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select extensions.throws_ok(
  $$select public.mark_my_notifications_read('{}'::uuid[])$$,
  '42501', 'Authentication is required', 'even an empty batch requires an authenticated account');

set local session_replication_role = replica;
insert into auth.users(id, email) values
  ('00000000-0000-4000-9000-000000000101', 'notification-batch-one@example.invalid'),
  ('00000000-0000-4000-9000-000000000102', 'notification-batch-two@example.invalid');
set local session_replication_role = origin;

insert into public.user_notifications(id, recipient_id, kind, title, event_key, read_at, created_at) values
  ('00000000-0000-4000-9000-000000000111', '00000000-0000-4000-9000-000000000101', 'test', 'First loaded notice', 'batch-111', null, '2026-09-08T00:00:00Z'),
  ('00000000-0000-4000-9000-000000000112', '00000000-0000-4000-9000-000000000101', 'test', 'Second loaded notice', 'batch-112', null, '2026-09-08T00:00:00Z'),
  ('00000000-0000-4000-9000-000000000113', '00000000-0000-4000-9000-000000000101', 'test', 'Third loaded notice', 'batch-113', null, '2026-09-08T00:00:00Z'),
  ('00000000-0000-4000-9000-000000000114', '00000000-0000-4000-9000-000000000101', 'test', 'New notice outside loaded list', 'batch-114', null, '2026-09-08T00:01:00Z'),
  ('00000000-0000-4000-9000-000000000115', '00000000-0000-4000-9000-000000000101', 'test', 'Previously read notice', 'batch-115', '2026-09-07T00:00:00Z', '2026-09-06T00:00:00Z'),
  ('00000000-0000-4000-9000-000000000211', '00000000-0000-4000-9000-000000000102', 'test', 'Another recipient notice', 'batch-211', null, '2026-09-08T00:00:00Z');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000000101', true);

select extensions.throws_ok(
  $$select public.mark_my_notifications_read(null)$$,
  '22023', 'Notification IDs are required', 'null cannot mean mark all');
select extensions.throws_ok(
  $$select public.mark_my_notifications_read(array['00000000-0000-4000-9000-000000000111'::uuid, null])$$,
  '22023', 'Notification IDs must not contain null', 'null elements reject the whole batch');
select extensions.throws_ok(
  $$select public.mark_my_notifications_read(array[['00000000-0000-4000-9000-000000000111'::uuid]])$$,
  '22023', 'Notification IDs must be a one-dimensional array', 'multidimensional arrays are rejected');
select extensions.throws_ok(
  $$select public.mark_my_notifications_read(array_fill('00000000-0000-4000-9000-000000000111'::uuid, array[101]))$$,
  '22023', 'At most 100 notification IDs are allowed', '101 IDs are rejected even if duplicated');
select extensions.throws_ok(
  $$select public.mark_my_notifications_read(array['bad-id']::uuid[])$$,
  '22P02', 'invalid input syntax for type uuid: "bad-id"', 'malformed UUIDs fail before any update');
select extensions.is(public.mark_my_notifications_read('{}'::uuid[]), 0, 'an empty list changes no notifications');

select extensions.is(
  public.mark_my_notifications_read(array_fill('00000000-0000-4000-9000-000000000111'::uuid, array[100])),
  1, '100 input IDs are allowed and duplicate IDs count only once');
select extensions.is(
  public.mark_my_notifications_read(array['00000000-0000-4000-9000-000000000111'::uuid]),
  0, 'replaying a successful batch is idempotent');
select extensions.is(
  public.mark_my_notifications_read(array[
    '00000000-0000-4000-9000-000000000112'::uuid,
    '00000000-0000-4000-9000-000000000112'::uuid,
    '00000000-0000-4000-9000-000000000113'::uuid,
    '00000000-0000-4000-9000-000000000115'::uuid,
    '00000000-0000-4000-9000-000000000211'::uuid,
    '00000000-0000-4000-9000-000000000999'::uuid
  ]), 2, 'mixed batches report only newly read rows belonging to this reader');
select extensions.is(
  (select read_at from public.user_notifications where id = '00000000-0000-4000-9000-000000000115'),
  '2026-09-07T00:00:00Z'::timestamptz, 'an already-read timestamp remains unchanged');
select extensions.ok(
  (select read_at is null from public.user_notifications where id = '00000000-0000-4000-9000-000000000211'),
  'explicitly supplying another recipients ID cannot mark it read');
select extensions.ok(
  (select read_at is null from public.user_notifications where id = '00000000-0000-4000-9000-000000000114'),
  'a newer notification absent from the loaded list stays unread');
select extensions.is(public.get_my_unread_notification_count(), 1, 'unread count retains the unseen notification');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000000102', true);
select extensions.is(
  public.mark_my_notifications_read(array['00000000-0000-4000-9000-000000000211'::uuid, '00000000-0000-4000-9000-000000000114'::uuid]),
  1, 'the second recipient can mark their own row but not the first readers row');
select extensions.ok(
  (select read_at is null from public.user_notifications where id = '00000000-0000-4000-9000-000000000114'),
  'switching recipients never changes the other account');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-9000-000000000101', true);
select extensions.is(public.mark_my_notification_read('00000000-0000-4000-9000-000000000114'::uuid), 1, 'legacy single-notification clients keep working');

select * from extensions.finish();
rollback;
