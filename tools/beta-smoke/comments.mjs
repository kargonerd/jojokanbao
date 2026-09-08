// Explicit, reversible hosted smoke test. Uses only synthetic accounts/content.
// Run: node tools/beta-smoke/comments.mjs [env-directory]
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvironment, literal, query, getAdminKey, request } from './lib.mjs';

const env = loadEnvironment(process.argv[2]);
const run = `beta-smoke-${randomUUID()}`;
const content = { p_content_type: 'book', p_content_id: run, p_section_id: 'smoke' };
const passed = [];
const users = [];
let invitation;
let failure;
mkdirSync('.runtime/beta-smoke', { recursive: true });
const reportPath = `.runtime/beta-smoke/${run}.json`;
const save = extra => writeFileSync(reportPath, JSON.stringify({ run, passed, ...extra }, null, 2));
save({ status: 'running' });
const check = (name, condition) => { assert.ok(condition, name); passed.push(name); };

async function rpc(user, name, body = {}, expected = true) {
  const result = await request(env, `rest/v1/rpc/${name}`, { token: user?.token, body });
  if (expected) assert.ok(result.ok, `${name}: HTTP ${result.status}, code ${result.data?.code ?? ''}`);
  return expected ? result.data : result;
}
const threads = user => rpc(user, 'get_annotation_threads', content);
const count = user => rpc(user, 'get_my_unread_notification_count');
const notifications = user => rpc(user, 'get_my_notifications', { p_limit: 50, p_before: null, p_before_id: null });

try {
  const adminKey = await getAdminKey(env);
  [invitation] = await query(env, `select * from private.create_signup_invitation(null, interval '1 hour', 3, ${literal(run)})`, false);
  for (let i = 0; i < 3; i++) {
    const email = `${run}-${i}@example.invalid`;
    const password = randomBytes(24).toString('base64url');
    const created = await request(env, 'auth/v1/admin/users', { token: adminKey, key: adminKey, body: {
      email, password, email_confirm: true, user_metadata: { invitation_code: invitation.code, beta_smoke_run: run },
    } });
    assert.ok(created.ok, `test account creation: HTTP ${created.status}`);
    const signedIn = await request(env, 'auth/v1/token?grant_type=password', { body: { email, password } });
    assert.ok(signedIn.ok, `test account login: HTTP ${signedIn.status}`);
    users.push({ id: signedIn.data.user.id, token: signedIn.data.access_token });
  }
  const [author, commenter, reporter] = users;
  check('three isolated accounts authenticated', users.length === 3);
  const anonymous = await rpc(null, 'create_content_annotation', {
    ...content, p_content_title: 'Beta 自动测试', p_content_url: '/library', p_quote: '自动测试原文',
  }, false);
  check('anonymous writes denied', !anonymous.ok);
  const annotation = await rpc(author, 'create_content_annotation', {
    ...content, p_content_title: 'Beta 自动测试', p_content_url: '/library', p_quote: '自动测试原文',
    p_start_offset: 0, p_end_offset: 6, p_initial_comment: '仅自己可见', p_initial_comment_visibility: 'private',
  });
  const privateId = annotation.comments.find(c => c.visibility === 'private')?.id;
  check('private thought readable by its author', Boolean(privateId));
  check('single private underline hidden from another reader', (await threads(commenter)).length === 0);
  check('private thought sends no notification', await count(commenter) === 0 && await count(reporter) === 0);
  const publicComment = await rpc(author, 'add_annotation_comment', { p_annotation_id: annotation.id, p_body: '公开测试评论' });
  const visible = await threads(commenter);
  check('public comment makes the thread visible', visible.length === 1 && visible[0].comments.some(c => c.id === publicComment.id));
  check('private comment excluded from another reader snapshot', !visible[0].comments.some(c => c.id === privateId));
  check('self comment does not notify self', await count(author) === 0);
  const underline = await rpc(commenter, 'create_content_annotation', {
    ...content, p_content_title: 'Beta 自动测试', p_content_url: '/library', p_quote: '自动测试原文',
    p_start_offset: 0, p_end_offset: 6,
  });
  check('two readers share one underline anchor', underline.id === annotation.id && underline.underlineCount === 2);
  const privateRows = await request(env, `rest/v1/annotation_comments?id=eq.${privateId}&select=id`, { token: commenter.token });
  check('direct table access also protects private comments', privateRows.status === 403 || (privateRows.ok && privateRows.data.length === 0));
  const privateReport = await rpc(reporter, 'report_annotation_comment', { p_comment_id: privateId, p_reason: 'spam' }, false);
  check('private comment cannot be discovered through reporting', !privateReport.ok);
  await rpc(commenter, 'add_annotation_comment', { p_annotation_id: annotation.id, p_body: '回复测试', p_parent_comment_id: publicComment.id });
  check('public reply notifies the parent author once', await count(author) === 1);
  await rpc(commenter, 'add_annotation_comment', { p_annotation_id: annotation.id, p_body: '私密测试', p_visibility: 'private' });
  check('private comment does not add notifications', await count(author) === 1);
  const notices = await notifications(author);
  check('reply notification points to discussion', notices.length === 1 && notices[0].targetPath?.includes('discussion='));
  await rpc(reporter, 'mark_my_notification_read', { p_notification_id: notices[0].id }, false);
  check('another reader cannot mark a notification read', await count(author) === 1);
  await rpc(author, 'mark_my_notification_read', { p_notification_id: notices[0].id });
  check('owner can mark notification read', await count(author) === 0);
  await rpc(commenter, 'add_annotation_comment', { p_annotation_id: annotation.id, p_body: '批量已读测试一', p_parent_comment_id: publicComment.id });
  const displayedNotice = (await notifications(author)).find(notice => !notice.readAt);
  check('batch read fixture contains a displayed unread notification', Boolean(displayedNotice));
  await rpc(commenter, 'add_annotation_comment', { p_annotation_id: annotation.id, p_body: '批量已读测试二', p_parent_comment_id: publicComment.id });
  const beforeBatch = await count(author);
  check('a later reply remains outside the displayed snapshot', beforeBatch === 2);
  const batch = (user, ids, expected = true) => rpc(user, 'mark_my_notifications_read', { p_notification_ids: ids }, expected);
  check('another reader cannot batch-mark the displayed notification', await batch(reporter, [displayedNotice.id]) === 0 && await count(author) === beforeBatch);
  check('batch mark changes only the displayed notification once', await batch(author, [displayedNotice.id, displayedNotice.id]) === 1 && await count(author) === 1);
  check('repeating a displayed batch is idempotent', await batch(author, [displayedNotice.id]) === 0 && await count(author) === 1);
  check('empty batch never marks all unread notifications', await batch(author, []) === 0 && await count(author) === 1);
  check('null batch is rejected without marking unseen notifications', !(await batch(author, null, false)).ok && await count(author) === 1);
  const report = await rpc(reporter, 'report_annotation_comment', { p_comment_id: publicComment.id, p_reason: 'other', p_details: '自动化测试，随后清理' });
  const pending = await rpc(null, 'operator_list_annotation_reports', { p_operator_token: env.JOJO_OPERATOR_TOKEN, p_status: 'pending' });
  check('operator queue contains the submitted report', pending.some(item => item.commentId === publicComment.id && item.reports.some(entry => entry.id === report.id)));
  const ownReport = await rpc(author, 'report_annotation_comment', { p_comment_id: publicComment.id, p_reason: 'spam' }, false);
  check('self reporting denied', !ownReport.ok);
  const denied = await rpc(null, 'operator_moderate_annotation_comment', {
    p_operator_token: 'invalid-test-token', p_comment_id: publicComment.id, p_action: 'hide', p_reason: '自动测试',
  }, false);
  check('moderation requires the operator token', !denied.ok);
  const moderate = action => rpc(null, 'operator_moderate_annotation_comment', {
    p_operator_token: env.JOJO_OPERATOR_TOKEN, p_comment_id: publicComment.id, p_action: action, p_reason: '自动化测试，随后清理',
  });
  await moderate('hide');
  check('moderation hides public text', !(await threads(commenter)).flatMap(t => t.comments).some(c => c.id === publicComment.id && c.body === '公开测试评论'));
  check('reporter receives moderation notification', (await notifications(reporter)).some(n => n.kind === 'moderation.report_resolved'));
  await moderate('restore');
  check('moderation can restore the comment', (await threads(commenter)).flatMap(t => t.comments).some(c => c.id === publicComment.id && c.body === '公开测试评论'));
  await rpc(reporter, 'report_annotation_comment', { p_comment_id: publicComment.id, p_reason: 'other' });
  await moderate('dismiss');
  check('dismiss keeps public comment visible', (await threads(commenter)).flatMap(t => t.comments).some(c => c.id === publicComment.id && c.body === '公开测试评论'));
  const reports = await query(env, `select status from public.annotation_comment_reports where id = ${literal(report.id)}::uuid`);
  check('dismiss resolves the report state', reports[0]?.status === 'dismissed');
} catch (error) {
  failure = error;
} finally {
  // Reconcile by the exact unique run marker even after an uncertain Auth response.
  await query(env, `begin;
    delete from public.content_annotations where content_id = ${literal(run)};
    delete from auth.users where raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)};
    delete from private.signup_invitations where note = ${literal(run)};
    commit;`, false);
  const [remaining] = await query(env, `select
    (select count(*) from public.content_annotations where content_id = ${literal(run)}) as annotations,
    (select count(*) from auth.users where raw_user_meta_data ->> 'beta_smoke_run' = ${literal(run)}) as users,
    (select count(*) from private.signup_invitations where note = ${literal(run)}) as invitations,
    (select count(*) from public.annotation_comments where user_id = any(array[${users.map(u => literal(u.id)).join(',')}]::uuid[])) as comments,
    (select count(*) from public.user_notifications where recipient_id = any(array[${users.map(u => literal(u.id)).join(',')}]::uuid[])) as notifications,
    (select count(*) from public.content_annotation_marks where user_id = any(array[${users.map(u => literal(u.id)).join(',')}]::uuid[])) as marks,
    (select count(*) from public.annotation_comment_reports where reporter_id = any(array[${users.map(u => literal(u.id)).join(',')}]::uuid[])) as reports`);
  const clean = Object.values(remaining).every(value => Number(value) === 0);
  check('all synthetic records cleaned up', clean);
  save({ status: failure ? 'failed' : 'passed', error: failure?.message, cleanup: remaining });
  console.log(JSON.stringify({ run, passed, cleanup: remaining, reportPath }, null, 2));
}
if (failure) throw failure;
