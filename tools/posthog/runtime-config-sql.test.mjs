import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { migrationDatabase } from './db-fixture.mjs';

const token = 'fixture-operator-token-with-at-least-32-characters';
const users = [randomUUID(), randomUUID(), randomUUID()];
let db, oldState;
const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
const actor = user => db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || '']);
async function rejectQuery(sql, args, pattern) {
  await db.exec('savepoint rejected');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint rejected; release savepoint rejected'); }
}
function receipt(email, code = '', required = false, expires = Math.floor(Date.now()/1000)+120) {
  const encoded = Buffer.from(JSON.stringify({email, code, required, expires})).toString('base64url');
  return `${encoded}.${createHmac('sha256', createHash('sha256').update(token).digest()).update(`jojo.signup.v1.${encoded}`).digest('hex')}`;
}
const metadata = (email, code = '', required = false) => ({ invitation_code: code, signup_authorization: receipt(email, code, required), keep: 'yes' });
const annotation = (operation, params, threshold = 2, credential = token) => value(
  'select public.annotation_request($1,$2,$3,$4::jsonb) as value', [credential, threshold, operation, JSON.stringify(params)]);
const subject = {p_content_type:'book',p_content_id:'book:test',p_section_id:'chapter:one'};
const anchor = {...subject,p_content_title:'Book',p_content_url:'/library/test',p_quote:'Shared anchor',p_prefix:'',p_suffix:''};

before(async () => {
  db = await migrationDatabase({beforeMigration: async database => {
    await database.query("insert into private.feature_flag_operator_secret(token_digest) values (extensions.digest($1,'sha256'))", [token]);
    for (const id of users) await database.query('insert into auth.users(id,email) values ($1,$2)', [id,`${id}@example.invalid`]);
    await database.query(`insert into private.agent_usage_state(user_id,usage_day,day_count,active_request_id,active_until)
      values($1,current_date,50,$2,now()+interval '1 hour')`, [users[2],randomUUID()]);
    oldState = (await database.query('select to_jsonb(s) as value from private.agent_usage_state s')).rows[0].value;
  }});
});
after(async () => db?.close());
beforeEach(async () => db.exec('begin'));
afterEach(async () => db.exec('rollback'));

test('all migrations remove the flag system and preserve operator credentials, readers and running usage', async () => {
  assert.equal(await value("select to_regclass('private.feature_flags') as value"), null);
  assert.equal(await value("select count(*)::integer as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and (p.proname like '%feature_flag%' or p.prosrc like '%private.feature_flags%')"), 0);
  assert.equal(await value('select private.operator_authorized($1) as value',[token]), true);
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

test('annotation thresholds come from trusted server parameters while private comments and ownership remain enforced', async () => {
  await actor(users[0]);
  const created=await annotation('create_content_annotation',anchor);
  await annotation('add_annotation_comment',{p_annotation_id:created.id,p_body:'Private note',p_visibility:'private'});
  await actor(users[1]);
  assert.deepEqual(await annotation('get_annotation_threads',subject),[]);
  const shared=await annotation('create_content_annotation',anchor);
  assert.equal(shared.underlineCount,2);
  assert.deepEqual(shared.comments,[]);
  await actor(users[2]);
  assert.equal((await annotation('get_annotation_threads',subject,2)).length,1);
  assert.equal((await annotation('get_annotation_threads',subject,3)).length,0);
  // Client payload cannot override the separately authenticated threshold.
  assert.equal((await annotation('get_annotation_threads',{...subject,p_public_mark_threshold:1},3)).length,0);
  await actor(users[1]);
  await annotation('add_annotation_comment',{p_annotation_id:created.id,p_body:'Public note'});
  await actor(users[2]);
  const visible=await annotation('get_annotation_threads',subject,100);
  assert.deepEqual(visible[0].comments.map(c=>c.body),['Public note']);
  const report=await annotation('report_annotation_comment',{p_comment_id:visible[0].comments[0].id,p_reason:'spam'});
  assert.ok(report.id);
  assert.equal(await value('select count(*)::integer as value from public.annotation_comment_reports where id=$1',[report.id]),1);
  await actor(users[0]);
  await annotation('delete_my_annotation_mark',{p_annotation_id:created.id});
  assert.equal(await value('select count(*)::integer as value from public.content_annotation_marks where annotation_id=$1',[created.id]),1);
  assert.equal(await value('select count(*)::integer as value from public.annotation_comments where annotation_id=$1',[created.id]),2);
});

test('unauthenticated readers and clients without the server credential cannot provide annotation parameters', async () => {
  await rejectQuery('select public.annotation_request($1,2,$2,$3)',[token,'get_annotation_threads',JSON.stringify(subject)],/Authentication is required/);
  await actor(users[0]);
  await rejectQuery('select public.annotation_request($1,1,$2,$3)',['untrusted','get_annotation_threads',JSON.stringify(subject)],/Operator token is invalid/);
  assert.equal(await value("select to_regprocedure('public.get_annotation_threads(text,text,text)') as value"),null);
  assert.equal(await value("select has_function_privilege('authenticated','public.add_annotation_comment(uuid,text,uuid,text)','execute') as value"),false);
});

test('AI limits use trusted request values and preserve atomic per-user concurrency and counts', async () => {
  const request=randomUUID();
  const acquire=(id,minute=1,day=2,seconds=60)=>value('select public.acquire_agent_usage($1,$2,$3,$4,$5,$6) as value',[token,users[0],id,minute,day,seconds]);
  assert.deepEqual(await acquire(request),{allowed:true,maxRunSeconds:60});
  assert.equal((await acquire(randomUUID())).reason,'concurrent');
  await value('select public.release_agent_usage($1,$2,$3) as value',[token,users[0],request]);
  assert.equal((await acquire(randomUUID())).reason,'minute');
  assert.equal((await acquire(randomUUID(),2,1)).reason,'daily');
  await rejectQuery('select public.acquire_agent_usage($1,$2,$3,0,2,60)',[token,users[0],randomUUID()],/parameters are invalid/);
  await rejectQuery('select public.acquire_agent_usage($1,$2,$3,1,2,60)',['untrusted',users[0],randomUUID()],/Operator token is invalid/);
  assert.equal(await value("select to_regprocedure('public.acquire_agent_usage(text,uuid,uuid)') as value"),null);
});
