-- Anchored content RPCs. Readers call them directly with their own session;
-- admin operations are executable only with the service API key and write to
-- the shared private.admin_actions audit table.

create or replace function private.anchor_item_snapshot(p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', item.id,
    'kind', item.kind,
    'type', item.type,
    'contentType', item.content_type,
    'contentId', item.content_id,
    'sectionId', item.section_id,
    'contentTitle', item.content_title,
    'contentUrl', item.content_url,
    'level', item.level,
    'itemId', item.item_id,
    'quote', item.quote,
    'prefix', item.prefix,
    'suffix', item.suffix,
    'startOffset', item.start_offset,
    'endOffset', item.end_offset,
    'anchorKey', item.anchor_key,
    'title', item.title,
    'payload', item.payload,
    'authorKey', item.author_key,
    'authorName', coalesce(profile.display_name, 'JOJO 读者'),
    'status', item.status,
    'moderationReason', item.moderation_reason,
    'createdBy', item.created_by,
    'createdAt', item.created_at,
    'updatedAt', item.updated_at
  )
  from public.anchor_items item
  left join public.profiles profile on profile.id = item.created_by
  where item.id = p_item_id
$$;

create or replace function public.get_anchor_items(
  p_content_type text,
  p_content_id text,
  p_section_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_anchor_reader();
begin
  return coalesce((
    select jsonb_agg(private.anchor_item_snapshot(item.id) order by item.created_at, item.id)
    from public.anchor_items item
    where item.content_type = p_content_type
      and item.content_id = p_content_id
      and item.section_id is not distinct from p_section_id
      and (item.status = 'approved' or item.created_by = reader_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.create_anchor_item(
  p_content_type text,
  p_content_id text,
  p_section_id text default null,
  p_content_title text default null,
  p_content_url text default null,
  p_level text default null,
  p_kind text default null,
  p_type text default null,
  p_title text default null,
  p_item_id text default null,
  p_quote text default null,
  p_prefix text default '',
  p_suffix text default '',
  p_start_offset integer default null,
  p_end_offset integer default null,
  p_payload jsonb default '{}'::jsonb,
  p_author_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_anchor_reader();
  editorial boolean := private.is_editorial_account();
  normalized_section text := nullif(btrim(coalesce(p_section_id, '')), '');
  normalized_title text := nullif(btrim(coalesce(p_title, '')), '');
  normalized_item_id text := nullif(btrim(coalesce(p_item_id, '')), '');
  normalized_prefix text := left(coalesce(p_prefix, ''), 160);
  normalized_suffix text := left(coalesce(p_suffix, ''), 160);
  normalized_path text := nullif(btrim(coalesce(p_content_url, '')), '');
  computed_anchor_key text;
  new_id uuid;
begin
  if p_content_type not in ('book', 'newspaper', 'magazine', 'article') then
    raise invalid_parameter_value using message = 'Unknown anchor content type';
  end if;
  if p_content_id is null or char_length(btrim(p_content_id)) not between 1 and 512 then
    raise invalid_parameter_value using message = 'Anchor content id is invalid';
  end if;
  if p_content_title is null or char_length(btrim(p_content_title)) not between 1 and 300 then
    raise invalid_parameter_value using message = 'Anchor content title is invalid';
  end if;
  if normalized_path is not null and (
    char_length(normalized_path) > 1024
    or left(normalized_path, 1) <> '/'
    or left(normalized_path, 2) = '//'
    or strpos(normalized_path, E'\\') > 0
    or normalized_path ~ E'[\\r\\n]'
  ) then
    raise invalid_parameter_value using message = 'Anchor target must be a local path';
  end if;
  if p_level not in ('work', 'section', 'paragraph', 'sentence') then
    raise invalid_parameter_value using message = 'Unknown anchor level';
  end if;
  if p_kind not in ('note', 'link') then
    raise invalid_parameter_value using message = 'Unknown anchor kind';
  end if;
  if p_type is null or char_length(btrim(p_type)) not between 1 and 40 then
    raise invalid_parameter_value using message = 'Anchor type is invalid';
  end if;
  if (p_level = 'work') <> (normalized_section is null) then
    raise invalid_parameter_value using message = 'Anchor level and section do not match';
  end if;
  perform private.validate_anchor_geometry(p_level, normalized_item_id, p_quote, p_start_offset, p_end_offset);
  perform private.validate_anchor_payload(p_kind, p_payload);

  if p_level = 'sentence' then
    computed_anchor_key := encode(extensions.digest(
      jsonb_build_array(p_quote, normalized_prefix, normalized_suffix, p_start_offset, p_end_offset)::text,
      'sha256'
    ), 'hex');
  end if;

  insert into public.anchor_items(
    kind, type, content_type, content_id, section_id, content_title, content_url,
    level, item_id, quote, prefix, suffix, start_offset, end_offset, anchor_key,
    title, payload, author_key, created_by, status, reviewed_at, reviewed_by
  ) values (
    p_kind, btrim(p_type), p_content_type, btrim(p_content_id), normalized_section,
    left(btrim(p_content_title), 300), normalized_path,
    p_level, normalized_item_id, p_quote, normalized_prefix, normalized_suffix,
    p_start_offset, p_end_offset, computed_anchor_key,
    normalized_title, p_payload,
    case when editorial then nullif(btrim(coalesce(p_author_key, '')), '') else null end,
    reader_id,
    case when editorial then 'approved' else 'pending' end,
    case when editorial then timezone('utc', now()) else null end,
    case when editorial then reader_id else null end
  )
  returning id into new_id;

  return private.anchor_item_snapshot(new_id);
end;
$$;

create or replace function public.delete_my_anchor_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reader_id uuid := private.require_anchor_reader();
  deleted_id uuid;
begin
  delete from public.anchor_items
    where id = p_item_id and created_by = reader_id and status = 'pending'
    returning id into deleted_id;
  if deleted_id is null then
    if exists (select 1 from public.anchor_items where id = p_item_id and created_by = reader_id) then
      raise invalid_parameter_value using message = 'Only pending items can be deleted';
    end if;
    raise no_data_found using message = 'Anchor item not found';
  end if;
  return jsonb_build_object('id', deleted_id, 'deleted', true);
end;
$$;

create or replace function public.admin_list_anchor_items(
  p_status text default 'pending',
  p_kind text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_status not in ('pending', 'approved', 'rejected', 'all') then
    raise invalid_parameter_value using message = 'Unknown anchor status';
  end if;
  if p_kind is not null and p_kind not in ('note', 'link') then
    raise invalid_parameter_value using message = 'Unknown anchor kind';
  end if;
  if p_limit not between 1 and 200 or p_offset < 0 then
    raise invalid_parameter_value using message = 'Anchor list paging is invalid';
  end if;
  return coalesce((
    select jsonb_agg(entry.payload order by entry.created_at, entry.id)
    from (
      select item.created_at, item.id, jsonb_build_object(
        'id', item.id,
        'kind', item.kind,
        'type', item.type,
        'contentType', item.content_type,
        'contentId', item.content_id,
        'sectionId', item.section_id,
        'contentTitle', item.content_title,
        'contentUrl', item.content_url,
        'level', item.level,
        'itemId', item.item_id,
        'quote', item.quote,
        'prefix', item.prefix,
        'suffix', item.suffix,
        'startOffset', item.start_offset,
        'endOffset', item.end_offset,
        'anchorKey', item.anchor_key,
        'title', item.title,
        'payload', item.payload,
        'authorKey', item.author_key,
        'status', item.status,
        'moderationReason', item.moderation_reason,
        'createdBy', item.created_by,
        'authorName', coalesce(profile.display_name, 'JOJO 读者'),
        'authorEmail', account.email::text,
        'createdAt', item.created_at,
        'reviewedAt', item.reviewed_at
      ) as payload
      from public.anchor_items item
      left join public.profiles profile on profile.id = item.created_by
      left join auth.users account on account.id = item.created_by
      where (p_status = 'all' or item.status = p_status)
        and (p_kind is null or item.kind = p_kind)
      order by item.created_at, item.id
      limit p_limit offset p_offset
    ) entry
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_review_anchor_item(
  p_actor_id uuid,
  p_item_id uuid,
  p_action text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_target_path text;
  notification_title text;
  item record;
begin
  if p_actor_id is null then
    raise insufficient_privilege;
  end if;
  if p_action not in ('approve', 'reject') then
    raise invalid_parameter_value using message = 'Unknown review action';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 2 and 500 then
    raise invalid_parameter_value using message = 'Moderation reason is required';
  end if;

  update public.anchor_items
    set status = case p_action when 'approve' then 'approved' else 'rejected' end,
      moderation_reason = left(btrim(p_reason), 500),
      reviewed_at = timezone('utc', now()),
      reviewed_by = p_actor_id,
      updated_at = timezone('utc', now())
    where id = p_item_id
    returning * into item;
  if not found then
    raise no_data_found using message = 'Anchor item not found';
  end if;

  insert into private.admin_actions(actor_id, action, target_id, reason)
    values (p_actor_id, 'anchor.' || p_action, p_item_id, left(btrim(p_reason), 500));

  notification_target_path := item.content_url;
  if notification_target_path is not null then
    notification_target_path := notification_target_path
      || case when strpos(notification_target_path, '?') > 0 then '&' else '?' end
      || 'anchor=' || item.id::text;
    if char_length(notification_target_path) > 1024 then
      notification_target_path := item.content_url;
    end if;
  end if;
  notification_title := case p_action
    when 'approve' then '你提交的内容已通过审核'
    else '你提交的内容未通过审核'
  end;

  perform private.enqueue_user_notification(
    item.created_by,
    p_actor_id,
    'anchor.review',
    notification_title,
    left(btrim(p_reason), 500),
    notification_target_path,
    'anchor_item',
    item.id::text,
    'anchor-item:' || item.id::text || ':' || p_action,
    jsonb_build_object(
      'anchorItemId', item.id,
      'kind', item.kind,
      'type', item.type,
      'contentType', item.content_type,
      'contentTitle', item.content_title,
      'sectionId', item.section_id,
      'title', item.title,
      'action', p_action
    )
  );

  return private.anchor_item_snapshot(item.id);
end;
$$;

create or replace function public.admin_update_anchor_item(
  p_actor_id uuid,
  p_item_id uuid,
  p_patch jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed_keys text[] := array['type', 'title', 'payload', 'quote', 'prefix', 'suffix', 'startOffset', 'endOffset', 'itemId', 'authorKey'];
  item record;
  merged_type text;
  merged_title text;
  merged_item_id text;
  merged_quote text;
  merged_prefix text;
  merged_suffix text;
  merged_start_offset integer;
  merged_end_offset integer;
  merged_payload jsonb;
  merged_author_key text;
begin
  if p_actor_id is null then
    raise insufficient_privilege;
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise invalid_parameter_value using message = 'Anchor patch must be an object';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 2 and 500 then
    raise invalid_parameter_value using message = 'Moderation reason is required';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) as key(value)
      where not (key.value = any(allowed_keys))
  ) then
    raise invalid_parameter_value using message = 'Anchor patch has unknown fields';
  end if;

  select * into item from public.anchor_items where id = p_item_id for update;
  if not found then
    raise no_data_found using message = 'Anchor item not found';
  end if;

  merged_type := coalesce(nullif(btrim(p_patch ->> 'type', ''), ''), item.type);
  merged_title := coalesce(nullif(btrim(p_patch ->> 'title', ''), ''), item.title);
  merged_item_id := coalesce(nullif(btrim(p_patch ->> 'itemId', ''), ''), item.item_id);
  merged_quote := coalesce(p_patch ->> 'quote', item.quote);
  merged_prefix := left(coalesce(p_patch ->> 'prefix', item.prefix), 160);
  merged_suffix := left(coalesce(p_patch ->> 'suffix', item.suffix), 160);
  merged_start_offset := coalesce((p_patch ->> 'startOffset')::integer, item.start_offset);
  merged_end_offset := coalesce((p_patch ->> 'endOffset')::integer, item.end_offset);
  merged_payload := coalesce(p_patch -> 'payload', item.payload);
  merged_author_key := coalesce(nullif(btrim(p_patch ->> 'authorKey', ''), ''), item.author_key);

  perform private.validate_anchor_geometry(item.level, merged_item_id, merged_quote, merged_start_offset, merged_end_offset);
  perform private.validate_anchor_payload(item.kind, merged_payload);

  update public.anchor_items
    set type = merged_type,
      title = merged_title,
      item_id = merged_item_id,
      quote = merged_quote,
      prefix = merged_prefix,
      suffix = merged_suffix,
      start_offset = merged_start_offset,
      end_offset = merged_end_offset,
      anchor_key = case when item.level = 'sentence' then encode(extensions.digest(
        jsonb_build_array(merged_quote, merged_prefix, merged_suffix, merged_start_offset, merged_end_offset)::text,
        'sha256'
      ), 'hex') else null end,
      payload = merged_payload,
      author_key = merged_author_key,
      updated_at = timezone('utc', now())
    where id = p_item_id;

  insert into private.admin_actions(actor_id, action, target_id, reason)
    values (p_actor_id, 'anchor.update', p_item_id, left(btrim(p_reason), 500));

  return private.anchor_item_snapshot(p_item_id);
end;
$$;

create or replace function public.admin_export_anchor_snapshot(p_content_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'contentId', p_content_id,
    'exportedAt', timezone('utc', now()),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'type', item.type,
        'level', item.level,
        'sectionId', item.section_id,
        'itemId', item.item_id,
        'quote', item.quote,
        'prefix', item.prefix,
        'suffix', item.suffix,
        'startOffset', item.start_offset,
        'endOffset', item.end_offset,
        'title', item.title,
        'payload', item.payload,
        'authorKey', item.author_key,
        'createdAt', item.created_at
      ) order by item.section_id nulls first, item.created_at, item.id)
      from public.anchor_items item
      where item.content_id = p_content_id
        and item.kind = 'note'
        and item.status = 'approved'
    ), '[]'::jsonb)
  )
$$;

create or replace function public.admin_upsert_seed_anchor_items(
  p_actor_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source jsonb;
  seed boolean;
  inserted_count integer := 0;
  updated_count integer := 0;
  computed_anchor_key text;
  new_id uuid;
begin
  if p_actor_id is null then
    raise insufficient_privilege;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) not between 1 and 1000 then
    raise invalid_parameter_value using message = 'Seed payload must be an array of 1-1000 items';
  end if;

  for source in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(source) is distinct from 'object' then
      raise invalid_parameter_value using message = 'Each seed entry must be an object';
    end if;
    if char_length(btrim(coalesce(source ->> 'seedKey', ''))) not between 1 and 128 then
      raise invalid_parameter_value using message = 'Each seed entry requires a seedKey';
    end if;
    if source ->> 'createdBy' is null or (source ->> 'createdBy')::uuid is null then
      raise invalid_parameter_value using message = 'Each seed entry requires a valid createdBy account';
    end if;
    if source ->> 'contentType' not in ('book', 'newspaper', 'magazine', 'article') then
      raise invalid_parameter_value using message = 'Unknown anchor content type';
    end if;
    if source ->> 'level' not in ('work', 'section', 'paragraph', 'sentence') then
      raise invalid_parameter_value using message = 'Unknown anchor level';
    end if;
    if source ->> 'kind' not in ('note', 'link') then
      raise invalid_parameter_value using message = 'Unknown anchor kind';
    end if;
    perform private.validate_anchor_geometry(
      source ->> 'level',
      nullif(btrim(coalesce(source ->> 'itemId', '')), ''),
      source ->> 'quote',
      (source ->> 'startOffset')::integer,
      (source ->> 'endOffset')::integer
    );
    perform private.validate_anchor_payload(source ->> 'kind', coalesce(source -> 'payload', '{}'::jsonb));

    computed_anchor_key := case when source ->> 'level' = 'sentence' then
      encode(extensions.digest(
        jsonb_build_array(
          source ->> 'quote',
          left(coalesce(source ->> 'prefix', ''), 160),
          left(coalesce(source ->> 'suffix', ''), 160),
          (source ->> 'startOffset')::integer,
          (source ->> 'endOffset')::integer
        )::text,
        'sha256'
      ), 'hex')
    else null end;

    select exists (
      select 1 from public.anchor_items where seed_key = btrim(source ->> 'seedKey')
    ) into seed;

    insert into public.anchor_items as existing(
      kind, type, content_type, content_id, section_id, content_title, content_url,
      level, item_id, quote, prefix, suffix, start_offset, end_offset, anchor_key,
      title, payload, author_key, seed_key, created_by, status, reviewed_at, reviewed_by
    ) values (
      source ->> 'kind',
      btrim(source ->> 'type'),
      source ->> 'contentType',
      btrim(source ->> 'contentId'),
      nullif(btrim(coalesce(source ->> 'sectionId', '')), ''),
      left(btrim(coalesce(source ->> 'contentTitle', '')), 300),
      nullif(btrim(coalesce(source ->> 'contentUrl', '')), ''),
      source ->> 'level',
      nullif(btrim(coalesce(source ->> 'itemId', '')), ''),
      source ->> 'quote',
      left(coalesce(source ->> 'prefix', ''), 160),
      left(coalesce(source ->> 'suffix', ''), 160),
      (source ->> 'startOffset')::integer,
      (source ->> 'endOffset')::integer,
      computed_anchor_key,
      nullif(btrim(coalesce(source ->> 'title', '')), ''),
      coalesce(source -> 'payload', '{}'::jsonb),
      nullif(btrim(coalesce(source ->> 'authorKey', '')), ''),
      btrim(source ->> 'seedKey'),
      (source ->> 'createdBy')::uuid,
      'approved',
      timezone('utc', now()),
      p_actor_id
    )
    on conflict (seed_key) where seed_key is not null do update set
      kind = excluded.kind,
      type = excluded.type,
      content_type = excluded.content_type,
      content_id = excluded.content_id,
      section_id = excluded.section_id,
      content_title = excluded.content_title,
      content_url = excluded.content_url,
      level = excluded.level,
      item_id = excluded.item_id,
      quote = excluded.quote,
      prefix = excluded.prefix,
      suffix = excluded.suffix,
      start_offset = excluded.start_offset,
      end_offset = excluded.end_offset,
      anchor_key = excluded.anchor_key,
      title = excluded.title,
      payload = excluded.payload,
      author_key = excluded.author_key,
      status = 'approved',
      reviewed_at = timezone('utc', now()),
      reviewed_by = p_actor_id,
      updated_at = timezone('utc', now())
    returning id into new_id;

    insert into private.admin_actions(actor_id, action, target_id, reason)
      values (p_actor_id, 'anchor.seed', new_id, 'seed ' || btrim(source ->> 'seedKey'));

    if seed then
      updated_count := updated_count + 1;
    else
      inserted_count := inserted_count + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', inserted_count, 'updated', updated_count);
end;
$$;

revoke all on function private.require_anchor_reader() from public, anon, authenticated;
revoke all on function private.is_editorial_account() from public, anon, authenticated;
revoke all on function private.validate_anchor_geometry(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function private.validate_anchor_payload(text, jsonb) from public, anon, authenticated;
revoke all on function private.anchor_item_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.get_anchor_items(text, text, text) from public, anon;
revoke all on function public.create_anchor_item(text, text, text, text, text, text, text, text, text, text, text, text, text, integer, integer, jsonb, text) from public, anon;
revoke all on function public.delete_my_anchor_item(uuid) from public, anon;
revoke all on function public.admin_list_anchor_items(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_review_anchor_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_update_anchor_item(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_export_anchor_snapshot(text) from public, anon, authenticated;
revoke all on function public.admin_upsert_seed_anchor_items(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.get_anchor_items(text, text, text) to authenticated;
grant execute on function public.create_anchor_item(text, text, text, text, text, text, text, text, text, text, text, text, text, integer, integer, jsonb, text) to authenticated;
grant execute on function public.delete_my_anchor_item(uuid) to authenticated;
grant execute on function public.admin_list_anchor_items(text, text, integer, integer) to service_role;
grant execute on function public.admin_review_anchor_item(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_update_anchor_item(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.admin_export_anchor_snapshot(text) to service_role;
grant execute on function public.admin_upsert_seed_anchor_items(uuid, jsonb) to service_role;

comment on table public.anchor_items is 'Anchored notes and links attached to delivered content; editorial accounts publish directly, user submissions await review.';
comment on function public.get_anchor_items(text, text, text) is 'Approved anchored content for one subject plus the caller''s own pending and rejected items.';
comment on function public.create_anchor_item(text, text, text, text, text, text, text, text, text, text, text, text, text, integer, integer, jsonb, text) is 'Create an anchored note or link; editorial accounts publish immediately, users submit for review.';
comment on function public.delete_my_anchor_item(uuid) is 'Delete the caller''s own pending anchored content.';
comment on function public.admin_list_anchor_items(text, text, integer, integer) is 'Server-only anchored content list for the moderation queue.';
comment on function public.admin_review_anchor_item(uuid, uuid, text, text) is 'Server-only approve or reject with audit and creator notification.';
comment on function public.admin_update_anchor_item(uuid, uuid, jsonb, text) is 'Server-only anchor repair used by the editing workbench.';
comment on function public.admin_export_anchor_snapshot(text) is 'Server-only approved note snapshot for EPUB baking.';
comment on function public.admin_upsert_seed_anchor_items(uuid, jsonb) is 'Server-only idempotent seed import from the content pipeline.';

create or replace function public.get_reader_runtime_contract()
returns text language sql immutable set search_path = '' as $$ select '202610060002'::text; $$;
revoke all on function public.get_reader_runtime_contract() from public;
grant execute on function public.get_reader_runtime_contract() to anon, authenticated;
