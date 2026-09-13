-- Issue test registration authorizations through the server-only API contract.
create function pg_temp.signup_metadata(email text, code text default '', required boolean default true)
returns jsonb language sql as $$
  select jsonb_build_object('invitation_code',code,'signup_authorization',public.authorize_signup(email,code,required));
$$;
