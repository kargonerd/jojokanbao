-- Transaction-scoped test signer standing in for the application API.
insert into private.operator_credentials(singleton, token_digest)
values (true, extensions.digest(repeat('t',32),'sha256'))
on conflict (singleton) do update set token_digest=excluded.token_digest;
create function pg_temp.signup_metadata(email text, code text default '', required boolean default true)
returns jsonb language plpgsql as $$
declare encoded text; signature text;
begin
  encoded := rtrim(translate(replace(encode(convert_to(jsonb_build_object(
    'email',lower(btrim(email)), 'code',private.normalize_signup_invitation_code(code),
    'required',required,'expires',extract(epoch from now())::bigint+120
  )::text,'UTF8'),'base64'), E'\n',''),'+/','-_'),'=');
  signature := encode(extensions.hmac(convert_to('jojo.signup.v1.'||encoded,'UTF8'),
    extensions.digest(repeat('t',32),'sha256'),'sha256'),'hex');
  return jsonb_build_object('invitation_code',code,'signup_authorization',encoded||'.'||signature);
end;
$$;
