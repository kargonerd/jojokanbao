-- Application APIs authorize users and supply trusted policy values. These
-- atomic database operations are executable only with the server API key.
create table private.signup_signing_secret (
  singleton boolean primary key default true check (singleton),
  signing_key bytea not null
);
revoke all on private.signup_signing_secret from public, anon, authenticated;
insert into private.signup_signing_secret(signing_key)
values (extensions.digest(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'), 'sha256'));

create function public.authorize_signup(p_email text, p_code text, p_invitation_required boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare payload jsonb; encoded text; signing_key bytea;
begin
  if p_email is null or char_length(p_email) not between 3 and 254
    or p_invitation_required is null or p_code is null or char_length(p_code) > 64 then
    raise invalid_parameter_value using message = 'Signup authorization input is invalid';
  end if;
  payload := jsonb_build_object('email', lower(btrim(p_email)),
    'code', private.normalize_signup_invitation_code(p_code), 'required', p_invitation_required,
    'expires', extract(epoch from now())::bigint + 120);
  encoded := rtrim(translate(replace(encode(convert_to(payload::text, 'UTF8'), 'base64'), E'\n', ''), '+/', '-_'), '=');
  select secret.signing_key into signing_key from private.signup_signing_secret secret where singleton;
  return encoded || '.' || encode(extensions.hmac(convert_to('jojo.signup.v1.' || encoded, 'UTF8'), signing_key, 'sha256'), 'hex');
end;
$$;
revoke all on function public.authorize_signup(text,text,boolean) from public, anon, authenticated;
grant execute on function public.authorize_signup(text,text,boolean) to service_role;

create table private.admin_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_id uuid not null,
  reason text not null,
  created_at timestamptz not null default now()
);
revoke all on private.admin_actions from public, anon, authenticated;

-- Preserve the existing business function bodies and change their caller
-- contract. Each old signature is removed and the new one is server-only.
do $$
declare definition text;
begin
  select pg_get_functiondef('private.signup_authorization_required(text,jsonb)'::regprocedure) into definition;
  definition := replace(definition,
    'select token_digest into signing_key from private.operator_credentials where singleton;',
    'select secret.signing_key into signing_key from private.signup_signing_secret secret where singleton;');
  execute definition;

  select pg_get_functiondef('public.acquire_agent_usage(text,uuid,uuid,integer,integer,integer)'::regprocedure) into definition;
  definition := replace(definition, 'p_operator_token text, ', '');
  definition := replace(definition, 'perform private.require_operator(p_operator_token);', '');
  drop function public.acquire_agent_usage(text,uuid,uuid,integer,integer,integer);
  execute definition;

  select pg_get_functiondef('public.release_agent_usage(text,uuid,uuid)'::regprocedure) into definition;
  definition := replace(definition, 'p_operator_token text, ', '');
  definition := replace(definition, 'perform private.require_operator(p_operator_token);', '');
  drop function public.release_agent_usage(text,uuid,uuid);
  execute definition;

  select pg_get_functiondef('public.annotation_request(text,integer,text,jsonb)'::regprocedure) into definition;
  definition := replace(definition, 'p_operator_token text', 'p_user_id uuid');
  definition := replace(definition, 'perform private.require_operator(p_operator_token);',
    'if p_user_id is null then raise insufficient_privilege; end if;
     perform set_config(''request.jwt.claim.sub'', p_user_id::text, true);
     perform set_config(''request.jwt.claims'', jsonb_build_object(''sub'',p_user_id,''role'',''authenticated'')::text, true);');
  drop function public.annotation_request(text,integer,text,jsonb);
  execute definition;

  select pg_get_functiondef('public.operator_list_annotation_reports(text,text)'::regprocedure) into definition;
  definition := replace(definition, 'operator_list_annotation_reports', 'admin_list_annotation_reports');
  definition := replace(definition, 'p_operator_token text, ', '');
  definition := replace(definition, 'perform private.require_operator(p_operator_token);', '');
  drop function public.operator_list_annotation_reports(text,text);
  execute definition;

  select pg_get_functiondef('public.operator_moderate_annotation_comment(text,uuid,text,text)'::regprocedure) into definition;
  definition := replace(definition, 'operator_moderate_annotation_comment', 'admin_moderate_annotation_comment');
  definition := replace(definition, 'p_operator_token text', 'p_actor_id uuid');
  definition := replace(definition, 'perform private.require_operator(p_operator_token);',
    'if p_actor_id is null then raise insufficient_privilege; end if;
     insert into private.admin_actions(actor_id,action,target_id,reason)
       values(p_actor_id,''comment.'' || p_action,p_comment_id,p_reason);');
  drop function public.operator_moderate_annotation_comment(text,uuid,text,text);
  execute definition;
end;
$$;

revoke all on function public.acquire_agent_usage(uuid,uuid,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.release_agent_usage(uuid,uuid) from public, anon, authenticated;
revoke all on function public.annotation_request(uuid,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.admin_list_annotation_reports(text) from public, anon, authenticated;
revoke all on function public.admin_moderate_annotation_comment(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.acquire_agent_usage(uuid,uuid,integer,integer,integer) to service_role;
grant execute on function public.release_agent_usage(uuid,uuid) to service_role;
grant execute on function public.annotation_request(uuid,integer,text,jsonb) to service_role;
grant execute on function public.admin_list_annotation_reports(text) to service_role;
grant execute on function public.admin_moderate_annotation_comment(uuid,uuid,text,text) to service_role;

drop function private.require_operator(text);
drop function private.operator_authorized(text);
drop table private.operator_credentials;

create or replace function public.get_reader_runtime_contract()
returns text language sql immutable set search_path = '' as $$ select '202609130005'::text; $$;
