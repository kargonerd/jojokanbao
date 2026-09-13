import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { migrationDatabase } from './db-fixture.mjs';

const token = 'fixture-operator-token-with-at-least-32-characters';
const users = [randomUUID(), randomUUID(), randomUUID()];
let db, oldState, signingKey;
const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const actor = user => db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
async function rejectQuery(sql, args, pattern) {
  await db.exec('savepoint rejected');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint rejected; release savepoint rejected'); }
}
function receipt(email, code = '', required = false, expires = Math.floor(Date.now()/1000)+120) {
  const encoded = Buffer.from(JSON.stringify({email, code, required, expires})).toString('base64url');
  return `${encoded}.${createHmac('sha256', signingKey).update(`jojo.signup.v1.${encoded}`).digest('hex')}`;
}
const metadata = (email, code = '', required = false) => ({ invitation_code: code, signup_authorization: receipt(email, code, required), keep: 'yes' });
// Readers reach the annotation RPCs directly. The disclosure threshold is a
// database constant, so no public signature accepts it.
const subject = {p_content_type:'book',p_content_id:'book:test',p_section_id:'chapter:one'};
const loadThreads = (fields = subject) => value(
  'select public.get_annotation_threads(p_content_type => $1::text, p_content_id => $2::text, p_section_id => $3::text) as value',
  [fields.p_content_type, fields.p_content_id, fields.p_section_id]);
const shareUnderline = () => value(
  `select public.create_content_annotation(p_content_type => $1::text, p_content_id => $2::text, p_section_id => $3::text,
     p_content_title => $4::text, p_content_url => $5::text, p_quote => $6::text) as value`,
  ['book','book:test','chapter:one','Book','/library/test','Shared anchor']);
const addComment = (annotationId, body, visibility = 'public') => value(
  `select public.add_annotation_comment(p_annotation_id => $1::uuid, p_body => $2::text,
     p_parent_comment_id => $3::uuid, p_visibility => $4::text) as value`, [annotationId, body, null, visibility]);
const reportComment = (commentId, reason) => value(
  `select public.report_annotation_comment(p_comment_id => $1::uuid, p_reason => $2::text, p_details => $3::text) as value`,
  [commentId, reason, null]);
const deleteMyMark = annotationId => value('select public.delete_my_annotation_mark($1::uuid) as value', [annotationId]);

before(async () => {
  db = await migrationDatabase({beforeMigration: async database => {
    await database.query("insert into private.feature_flag_operator_secret(token_digest) values (extensions.digest($1,'sha256'))", [token]);
    for (const id of users) await database.query('insert into auth.users(id,email) values ($1,$2)', [id,`${id}@example.invalid`]);
    await database.query(`insert into private.agent_usage_state(user_id,usage_day,day_count,active_request_id,active_until)
      values($1,current_date,50,$2,now()+interval '1 hour')`, [users[2],randomUUID()]);
    oldState = (await database.query('select to_jsonb(s) as value from private.agent_usage_state s')).rows[0].value;
  }});
  signingKey = await value('select signing_key as value from private.signup_signing_secret');
});
after(async () => db?.close());
beforeEach(async () => db.exec('begin'));
afterEach(async () => db.exec('rollback'));

test('all migrations remove the flag system and preserve readers and running usage', async () => {
  assert.equal(await value("select to_regclass('private.feature_flags') as value"), null);
  assert.equal(await value("select count(*)::integer as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and (p.proname like '%feature_flag%' or p.prosrc like '%private.feature_flags%')"), 0);
  assert.equal(await value("select to_regclass('private.operator_credentials') as value"), null);
  assert.deepEqual(await value('select to_jsonb(s) as value from private.agent_usage_state s'), oldState);
  assert.equal(await value('select count(*)::integer as value from auth.users'), 3);
});

test('open registration uses server authorization and removes its metadata without consuming an invite', async () => {
  const email='open@example.invalid', id=randomUUID();
  const data=metadata(email);
  assert.deepEqual(await value('select public.hook_require_signup_invitation($1::jsonb) as value',[JSON.stringify({user:{email,user_metadata:data}})]), {});
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,email,JSON.stringify(data)]);
  assert.deepEqual(await value('select raw_user_meta_data as value from auth.users where id=$1',[id]),{keep:'yes'});
  assert.equal(await value('select count(*)::integer as value from private.signup_invitation_redemptions where user_id=$1',[id]),0);
});

test('client policy values, forged signatures, changed email/code, missing and expired authorizations cannot open registration', async () => {
  const email='denied@example.invalid';
  const good=metadata(email,'ABC234',true);
  const cases=[{}, {invitationRequired:false}, {...good,signup_authorization:good.signup_authorization+'0'},
    {...good,invitation_code:'ZZZ999'}, metadata('other@example.invalid'),
    {signup_authorization:receipt(email,'',false,Math.floor(Date.now()/1000)-60)}];
  for(const data of cases) await rejectQuery('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',
    [randomUUID(),email,JSON.stringify(data)],/Registration authorization is invalid/);
});

test('required invitations are redeemed atomically once, including when a client skips the Auth hook', async () => {
  await db.exec("insert into private.signup_invitations(code,max_uses,kind) values('ABC234',1,'admin')");
  const email='invited@example.invalid';
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[randomUUID(),email,JSON.stringify(metadata(email,'ABC234',true))]);
  const other='second@example.invalid';
  await rejectQuery('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[randomUUID(),other,JSON.stringify(metadata(other,'ABC234',true))],/Invitation code could not be redeemed/);
  assert.equal(await value("select use_count as value from private.signup_invitations where code='ABC234'"),1);
});

test('the disclosure threshold is a database constant while private comments and ownership remain enforced', async () => {
  await actor('');
  await rejectQuery('select public.get_annotation_threads($1,$2,$3)',['book','book:test','chapter:one'],/Authentication is required/);
  await actor(users[0]);
  const created=await shareUnderline();
  await addComment(created.id,'Private note','private');
  await actor(users[1]);
  assert.deepEqual(await loadThreads(),[]);
  const shared=await shareUnderline();
  assert.equal(shared.underlineCount,2);
  assert.deepEqual(shared.comments,[]);
  await actor(users[2]);
  assert.equal((await loadThreads()).length,1);
  // Callers cannot supply any disclosure policy any more.
  assert.equal(await value(`select count(*)::integer as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proargnames::text like '%threshold%' or p.prosrc like '%publicMarkThreshold%')`),0);
  await actor(users[1]);
  await addComment(created.id,'Public note');
  await actor(users[2]);
  const visible=await loadThreads();
  assert.deepEqual(visible[0].comments.map(c=>c.body),['Public note']);
  const report=await reportComment(visible[0].comments[0].id,'spam');
  assert.ok(report.id);
  assert.equal(await value('select count(*)::integer as value from public.annotation_comment_reports where id=$1',[report.id]),1);
  await actor(users[0]);
  await deleteMyMark(created.id);
  assert.equal(await value('select count(*)::integer as value from public.content_annotation_marks where annotation_id=$1',[created.id]),1);
  assert.equal(await value('select count(*)::integer as value from public.annotation_comments where annotation_id=$1',[created.id]),2);
});

test('annotation RPCs serve authenticated readers directly instead of a server-only dispatcher', async () => {
  await actor(users[0]);
  for(const signature of [
    'public.get_annotation_threads(text,text,text)',
    'public.create_content_annotation(text,text,text,text,text,text,text,text,integer,integer,text,text)',
    'public.add_annotation_comment(uuid,text,uuid,text)',
    'public.report_annotation_comment(uuid,text,text)',
    'public.set_annotation_comment_like(uuid,boolean)',
    'public.delete_my_annotation_mark(uuid)',
    'public.delete_my_annotation_comment(uuid)',
    'public.get_my_book_annotations(text,uuid,integer)',
    'public.get_public_book_annotations(text,uuid,integer)',
  ]) assert.equal(await value(`select has_function_privilege('authenticated','${signature}','execute')
    and not has_function_privilege('anon','${signature}','execute') as value`),true,signature);
  assert.equal(await value("select to_regprocedure('public.annotation_request(uuid,integer,text,jsonb)') as value"),null);
});

test('AI limits use trusted request values and preserve atomic per-user concurrency and counts', async () => {
  const request=randomUUID();
  const acquire=(id,minute=1,day=2,seconds=60)=>value('select public.acquire_agent_usage($1,$2,$3,$4,$5) as value',[users[0],id,minute,day,seconds]);
  assert.deepEqual(await acquire(request),{allowed:true,maxRunSeconds:60});
  assert.equal((await acquire(randomUUID())).reason,'concurrent');
  await value('select public.release_agent_usage($1,$2) as value',[users[0],request]);
  assert.equal((await acquire(randomUUID())).reason,'minute');
  assert.equal((await acquire(randomUUID(),2,1)).reason,'daily');
  await rejectQuery('select public.acquire_agent_usage($1,$2,0,2,60)',[users[0],randomUUID()],/parameters are invalid/);
  assert.equal(await value("select has_function_privilege('authenticated','public.acquire_agent_usage(uuid,uuid,integer,integer,integer)','execute') as value"),false);
  assert.equal(await value("select to_regprocedure('public.acquire_agent_usage(text,uuid,uuid)') as value"),null);
});
