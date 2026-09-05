begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(36);

select extensions.has_table('private', 'feature_flags', 'feature flag configuration uses one private table');
select extensions.has_table('private', 'feature_flag_operator_secret', 'only the operator token digest has separate storage');
select extensions.hasnt_table('private', 'feature_flag_rules', 'rules are not split into a second table');
select extensions.hasnt_table('private', 'feature_flag_rule_users', 'user rules are embedded in the rules document');
select extensions.hasnt_table('private', 'feature_flag_audit_log', 'history is embedded in each flag row');
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'private.feature_flags', 'select'),
  'browser users cannot download raw feature rules or history'
);
select extensions.col_type_is('private', 'feature_flags', 'rules', 'jsonb', 'ordered rules are stored as JSONB');
select extensions.col_type_is('private', 'feature_flags', 'config', 'jsonb', 'flag-specific runtime config stays on the same row');
select extensions.is(
  private.feature_flag_normalize_config('{"futureSetting":{"enabled":true}}'::jsonb),
  '{"futureSetting":{"enabled":true}}'::jsonb,
  'generic config accepts future keys without a database schema change'
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

select extensions.throws_ok(
  $$select public.operator_list_feature_flags('wrong-token')$$,
  '42501',
  'Feature flag operator token is invalid',
  'management RPCs reject an invalid operator token'
);

select extensions.is(
  jsonb_array_length(public.operator_list_feature_flags(repeat('o', 32))),
  3,
  'the configured operator token can list flags'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate('reader.speech', (select other_id from feature_flag_test_state), null)),
  false,
  'listening starts disabled even for authenticated readers'
);

select extensions.throws_ok(
  $$select public.operator_get_feature_flag('wrong-token', 'reader.annotations')$$,
  '42501',
  'Feature flag operator token is invalid',
  'runtime rule reads reject an invalid operator token'
);

select extensions.is(
  public.operator_get_feature_flag(repeat('o', 32), 'reader.annotations')->>'revision',
  '1',
  'the protected runtime read returns one rule document'
);

select extensions.is(
  public.operator_get_feature_flag(repeat('o', 32), 'reader.annotations')->'config'->>'publicMarkThreshold',
  '2',
  'the protected runtime read returns the annotation public threshold'
);

select extensions.is(
  public.operator_publish_feature_flag(
    repeat('o', 32),
    'reader.annotations',
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
    jsonb_build_object('publicMarkThreshold', 3),
    1,
    'Enable internal reader',
    'feature-test-1'
  )->>'revision',
  '2',
  'publishing an ordered rule document increments the revision'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'reader.annotations',
    (select allowed_id from feature_flag_test_state),
    null
  )),
  true,
  'a user-list rule can serve on before the fallback'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'reader.annotations',
    (select other_id from feature_flag_test_state),
    null
  )),
  false,
  'a reader outside the user rule reaches the global off fallback'
);

select extensions.is(
  jsonb_array_length(private.feature_flag_snapshot('reader.annotations')->'history'),
  2,
  'publishing appends the new complete snapshot to the history field'
);

select extensions.is(
  private.feature_flag_snapshot('reader.annotations')->'config'->>'publicMarkThreshold',
  '3',
  'publishing changes the structured config with the rules'
);

select extensions.throws_ok(
  $$
    select public.operator_publish_feature_flag(
      repeat('o', 32),
      'reader.annotations',
      '[{"name":"Invalid fraction","conditionType":"percentage","serve":true,"percentage":0,"bucketBy":"user","enabled":true,"isFallback":false},{"name":"Default","conditionType":"global","serve":false,"enabled":true,"isFallback":true}]'::jsonb,
      jsonb_build_object('publicMarkThreshold', 3),
      2,
      'Invalid percentage test',
      null
    )
  $$,
  '22023',
  'Percentage rules must use an integer from 1 to 100',
  'percentage rules reject values below the one-percent minimum'
);

select extensions.throws_ok(
  $$
    select public.operator_publish_feature_flag(
      repeat('o', 32),
      'reader.annotations',
      '[{"name":"Not a fallback","conditionType":"users","serve":true,"enabled":true,"isFallback":false,"userIds":[]}]'::jsonb,
      jsonb_build_object('publicMarkThreshold', 3),
      2,
      'Invalid fallback test',
      null
    )
  $$,
  '22023',
  'The last rule must be the single enabled global fallback',
  'publishing requires one final global fallback'
);

select extensions.is(
  public.operator_publish_feature_flag(
    repeat('o', 32),
    'reader.annotations',
    jsonb_build_array(
      jsonb_build_object('name', '立即关闭', 'conditionType', 'global', 'serve', false, 'enabled', true, 'isFallback', false),
      jsonb_build_object('name', '内部读者', 'conditionType', 'users', 'serve', true, 'enabled', true, 'isFallback', false, 'userIds', jsonb_build_array((select allowed_id from feature_flag_test_state))),
      jsonb_build_object('name', '默认关闭', 'conditionType', 'global', 'serve', false, 'enabled', true, 'isFallback', true)
    ),
    jsonb_build_object('publicMarkThreshold', 4),
    2,
    'Put global off first',
    'feature-test-2'
  )->>'revision',
  '3',
  'a leading global off rule replaces a special emergency field'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'reader.annotations',
    (select allowed_id from feature_flag_test_state),
    null
  )),
  false,
  'the first global off rule stops before the whitelist'
);

select extensions.is(
  public.operator_rollback_feature_flag(
    repeat('o', 32),
    'reader.annotations',
    2,
    3,
    'feature-rollback-1'
  )->>'revision',
  '4',
  'rolling back publishes the selected snapshot as a new revision'
);

select extensions.is(
  private.feature_flag_snapshot('reader.annotations')->'config'->>'publicMarkThreshold',
  '3',
  'rollback restores the selected config together with its rules'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'reader.annotations',
    (select allowed_id from feature_flag_test_state),
    null
  )),
  true,
  'rollback restores the selected rules'
);

select extensions.is(
  jsonb_array_length(private.feature_flag_snapshot('reader.annotations')->'history'),
  4,
  'rollback is also appended to history'
);

select extensions.is(
  private.feature_flag_snapshot('reader.annotations')->'history'->3->>'reason',
  '回滚到 revision 2',
  'rollback history records the source revision'
);

select extensions.is(
  jsonb_array_length(private.feature_flag_snapshot('reader.annotations')->'rules'),
  2,
  'the current rule document is stored on the flag row'
);

select extensions.is(
  private.feature_flag_snapshot('reader.annotations')->'history'->1->>'requestId',
  'feature-test-1',
  'history retains the request id for each modification'
);

select extensions.is(
  private.feature_flag_snapshot('reader.annotations')->'history'->1->'config'->>'publicMarkThreshold',
  '3',
  'history retains the complete config snapshot for each modification'
);

select extensions.is(
  private.feature_flag_config_integer(
    'reader.annotations', array['publicMarkThreshold'], 2, 4, 100
  ),
  2,
  'the generic integer reader falls back when a stored value is outside caller bounds'
);

select extensions.throws_ok(
  $$
    select public.operator_publish_feature_flag(
      repeat('o', 32),
      'reader.annotations',
      '[{"name":"Default","conditionType":"global","serve":false,"enabled":true,"isFallback":true}]'::jsonb,
      jsonb_build_object('publicMarkThreshold', 3),
      3,
      'Stale update test',
      null
    )
  $$,
  '40001',
  'Feature flag revision conflict',
  'a stale revision cannot overwrite a newer configuration'
);

select * from extensions.finish();
rollback;
