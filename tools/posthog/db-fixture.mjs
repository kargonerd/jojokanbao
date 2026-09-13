import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

export async function migrationDatabase({ beforeMigration } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    create schema auth; create schema extensions; create schema storage;
    grant usage on schema extensions to anon, authenticated, service_role, supabase_auth_admin;
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key, statements text[]);
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
      raw_app_meta_data jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(),
      email_confirmed_at timestamptz, last_sign_in_at timestamptz, deleted_at timestamptz);
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key, bucket_id text, name text, owner_id text, owner uuid, metadata jsonb);
    create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
    create function extensions.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')) $$;
    create function extensions.digest(bytea,text) returns bytea language sql as $$ select sha256($1) $$;
    create function extensions.gen_random_uuid() returns uuid language sql as $$ select pg_catalog.gen_random_uuid() $$;
    create function extensions.gen_random_bytes(integer) returns bytea language sql as $$
      select decode(string_agg(lpad(to_hex(floor(random()*256)::integer),2,'0'),''),'hex') from generate_series(1,$1) $$;
    -- PGlite exposes SHA-256 but not the pgcrypto extension. RFC 2104 HMAC-SHA256
    -- lets the real authorization verifier run against Node/Python signatures.
    create function extensions.hmac(data bytea,key bytea,algorithm text) returns bytea language plpgsql as $$
    declare k bytea := key; ipad bytea := decode(repeat('36',64),'hex'); opad bytea := decode(repeat('5c',64),'hex'); i integer;
    begin
      if length(k)>64 then k:=sha256(k); end if;
      for i in 0..length(k)-1 loop
        ipad:=set_byte(ipad,i,get_byte(ipad,i)#get_byte(k,i));
        opad:=set_byte(opad,i,get_byte(opad,i)#get_byte(k,i));
      end loop;
      return sha256(opad||sha256(ipad||data));
    end $$;
  `);
  const dir = new URL('../../infrastructure/supabase/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    if (file === '202609130002_posthog_runtime.sql') await beforeMigration?.(db);
    let sql = await readFile(new URL(file, dir), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto with schema extensions;/gi, '');
    try {
      await db.exec(sql);
      await db.query('insert into supabase_migrations.schema_migrations(version,statements) values($1,$2)', [file.split('_')[0],[sql]]);
    }
    catch (error) { await db.close(); throw new Error(`${file}: ${error.message}`, { cause: error }); }
  }
  return db;
}
