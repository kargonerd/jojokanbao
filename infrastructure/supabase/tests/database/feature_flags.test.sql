begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(20);

select extensions.has_table('private', 'feature_flags', 'feature flags are stored privately');
select extensions.has_table('private', 'feature_flag_rules', 'ordered rules are stored privately');
select extensions.has_table('private', 'feature_flag_rule_users', 'user rules use stable auth user ids');
select extensions.has_table('private', 'feature_flag_operator_secret', 'only the operator token digest is stored');
select extensions.has_table('private', 'feature_flag_audit_log', 'publishes are audited');
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'private.feature_flag_rules', 'select'),
  'browser users cannot download raw feature rules'
);

create temporary table feature_flag_test_state (
  allowed_id uuid not null default extensions.gen_random_uuid(),
  other_id uuid not null default extensions.gen_random_uuid()
);
insert into feature_flag_test_state default values;

set local session_replication_role = replica;
insert into auth.users(id, email, raw_user_meta_data)
select allowed_id, 'flag-allowed@example.invalid', '{}'::jsonb from feature_flag_test_state
union all
select other_id, 'flag-reader@example.invalid', '{}'::jsonb from feature_flag_test_state;
set local session_replication_role = origin;

insert into private.feature_flag_operator_secret(singleton, token_digest)
values (true, extensions.digest(repeat('o', 32), 'sha256'));

select extensions.is(
  (select enabled from private.feature_flag_evaluate('library.bookshelf', null, null)),
  false,
  'an authenticated-only rule falls through to the global off rule for anonymous users'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'library.bookshelf',
    (select other_id from feature_flag_test_state),
    null
  )),
  true,
  'an authenticated reader matches the first bookshelf rule'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'olds.workspace',
    (select allowed_id from feature_flag_test_state),
    null
  )),
  false,
  'Olds remains globally disabled'
);

select extensions.throws_ok(
  $$select public.operator_list_feature_flags('wrong-token')$$,
  '42501',
  'Feature flag operator token is invalid',
  'management RPCs reject an invalid operator token'
);

select extensions.is(
  jsonb_array_length(public.operator_list_feature_flags(repeat('o', 32))),
  5,
  'the configured operator token can list flags'
);

select extensions.is(
  public.operator_publish_feature_flag(
    repeat('o', 32),
    'agent.chat',
    jsonb_build_array(
      jsonb_build_object(
        'name', '内部读者',
        'conditionType', 'users',
        'serve', true,
        'enabled', true,
        'isFallback', false,
        'userIds', jsonb_build_array((select allowed_id from feature_flag_test_state))
      ),
      jsonb_build_object(
        'name', '默认关闭',
        'conditionType', 'global',
        'serve', false,
        'enabled', true,
        'isFallback', true
      )
    ),
    false,
    1,
    'Enable internal reader',
    'feature-test-1'
  )->>'revision',
  '2',
  'publishing an ordered rule chain increments the revision'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'agent.chat',
    (select allowed_id from feature_flag_test_state),
    null
  )),
  true,
  'a user-list rule can serve on before the fallback'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'agent.chat',
    (select other_id from feature_flag_test_state),
    null
  )),
  false,
  'a reader outside the user rule reaches the global off fallback'
);

select extensions.is(
  public.operator_publish_feature_flag(
    repeat('o', 32),
    'agent.chat',
    jsonb_build_array(
      jsonb_build_object(
        'name', '内部读者',
        'conditionType', 'users',
        'serve', true,
        'enabled', true,
        'isFallback', false,
        'userIds', jsonb_build_array((select allowed_id from feature_flag_test_state))
      ),
      jsonb_build_object(
        'name', '默认关闭',
        'conditionType', 'global',
        'serve', false,
        'enabled', true,
        'isFallback', true
      )
    ),
    true,
    2,
    'Emergency stop test',
    'feature-test-2'
  )->>'revision',
  '3',
  'emergency disable is published with the same revisioned update'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'agent.chat',
    (select allowed_id from feature_flag_test_state),
    null
  )),
  false,
  'emergency disable overrides an earlier whitelist rule'
);

select extensions.throws_ok(
  $$
    insert into private.feature_flag_rules(
      flag_key, position, name, condition_type, serve, percentage, bucket_by, bucket_salt
    ) values (
      'agent.chat', 99, 'Invalid fraction', 'percentage', true, 0, 'user', extensions.gen_random_uuid()
    )
  $$,
  '23514',
  null,
  'percentage rules reject values below the one-percent minimum'
);

select extensions.throws_ok(
  $$
    select public.operator_publish_feature_flag(
      repeat('o', 32),
      'agent.chat',
      '[{"name":"Not a fallback","conditionType":"users","serve":true,"enabled":true,"isFallback":false,"userIds":[]}]'::jsonb,
      false,
      3,
      'Invalid fallback test',
      null
    )
  $$,
  '22023',
  'The last rule must be the single enabled global fallback',
  'publishing requires one final global fallback'
);

select extensions.is(
  (select count(*) from private.feature_flag_audit_log where flag_key = 'agent.chat'),
  2::bigint,
  'every successful publish appends an audit record'
);

select extensions.is(
  private.feature_flag_snapshot('agent.chat')->>'emergencyDisabled',
  'true',
  'management snapshots expose emergency state'
);

select * from extensions.finish();
rollback;
