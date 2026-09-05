-- Listening is a frontend rollout gate, independent of JOJO_TTS_ENABLED.
-- Missing RPC/row/errors also stay OFF. Do not open this to all users on deploy.
insert into private.feature_flags (key, description, rules)
values ('reader.speech', '听书与听新闻（Web、Desktop、Mobile）', jsonb_build_array(
  jsonb_build_object('id', '20000000-0000-4000-8000-000000000003', 'name', '默认关闭', 'conditionType', 'global',
    'serve', false, 'enabled', true, 'isFallback', true, 'percentage', null,
    'bucketBy', null, 'bucketSalt', null, 'startsAt', null, 'endsAt', null, 'userIds', jsonb_build_array())
))
on conflict (key) do nothing;

update private.feature_flags set history = jsonb_build_array(jsonb_build_object(
  'revision', revision, 'rules', rules, 'reason', '听读初始配置：默认关闭',
  'requestId', null, 'updatedAt', updated_at
)) where key = 'reader.speech' and history = '[]'::jsonb;
