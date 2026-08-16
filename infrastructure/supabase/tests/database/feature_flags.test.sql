begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(19);

select extensions.has_table('private', 'feature_flags', 'feature flags are stored privately');
select extensions.has_table('private', 'feature_flag_rules', 'ordered rules are stored privately');
select extensions.has_table('private', 'feature_flag_rule_users', 'user rules use stable auth user ids');
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'private.feature_flag_rules', 'select'),
  'browser users cannot download raw feature rules'
);

create temporary table feature_flag_test_state (
  admin_id uuid not null default extensions.gen_random_uuid(),
  other_id uuid not null default extensions.gen_random_uuid()
);
insert into feature_flag_test_state default values;

set local session_replication_role = replica;
insert into auth.users(id, email, raw_user_meta_data)
select admin_id, 'flag-admin@example.invalid', '{}'::jsonb from feature_flag_test_state
union all
select other_id, 'flag-reader@example.invalid', '{}'::jsonb from feature_flag_test_state;
set local session_replication_role = origin;

insert into private.feature_flag_admins(user_id, role)
select admin_id, 'editor' from feature_flag_test_state;

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
    (select admin_id from feature_flag_test_state),
    null
  )),
  false,
  'Olds remains globally disabled even for a feature administrator'
);

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select admin_id::text from feature_flag_test_state),
    true
  );
end;
$$;

select extensions.is(
  public.get_my_feature_flag_admin_role(),
  'editor',
  'the database-maintained administrator role is visible to its owner'
);

select extensions.is(
  jsonb_array_length(public.admin_list_feature_flags()),
  5,
  'an administrator can list the seeded flags'
);

select extensions.is(
  public.admin_publish_feature_flag(
    'agent.chat',
    jsonb_build_array(
      jsonb_build_object(
        'name', '内部读者',
        'conditionType', 'users',
        'serve', true,
        'enabled', true,
        'isFallback', false,
        'userIds', jsonb_build_array((select admin_id from feature_flag_test_state))
      ),
      jsonb_build_object(
        'name', '默认关闭',
        'conditionType', 'global',
        'serve', false,
        'enabled', true,
        'isFallback', true
      )
    ),
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
    (select admin_id from feature_flag_test_state),
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
  public.admin_publish_feature_flag(
    'agent.chat',
    jsonb_build_array(
      jsonb_build_object(
        'name', '紧急全关',
        'conditionType', 'global',
        'serve', false,
        'enabled', true,
        'isFallback', false
      ),
      jsonb_build_object(
        'name', '内部读者',
        'conditionType', 'users',
        'serve', true,
        'enabled', true,
        'isFallback', false,
        'userIds', jsonb_build_array((select admin_id from feature_flag_test_state))
      ),
      jsonb_build_object(
        'name', '默认关闭',
        'conditionType', 'global',
        'serve', false,
        'enabled', true,
        'isFallback', true
      )
    ),
    2,
    'Emergency stop test',
    'feature-test-2'
  )->>'revision',
  '3',
  'a global off rule can be published at the beginning'
);

select extensions.is(
  (select enabled from private.feature_flag_evaluate(
    'agent.chat',
    (select admin_id from feature_flag_test_state),
    null
  )),
  false,
  'first-match-wins makes the first global off rule stop the former allow rule'
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
    select public.admin_publish_feature_flag(
      'agent.chat',
      '[{"name":"Not a fallback","conditionType":"users","serve":true,"enabled":true,"isFallback":false,"userIds":[]}]'::jsonb,
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

do $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    (select other_id::text from feature_flag_test_state),
    true
  );
end;
$$;

select extensions.is(
  public.get_my_feature_flag_admin_role(),
  null::text,
  'ordinary readers are not feature administrators'
);

select extensions.throws_ok(
  'select public.admin_list_feature_flags()',
  '42501',
  'Feature flag administrator access required',
  'ordinary readers cannot call management RPCs'
);

select * from extensions.finish();
rollback;
