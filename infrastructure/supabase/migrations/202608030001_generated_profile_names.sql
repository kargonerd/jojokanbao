-- Give every reader a usable nickname while keeping names editable.

create or replace function private.random_profile_display_name()
returns text
language sql
volatile
set search_path = ''
as $$
  select names[
    1 + floor(random() * pg_catalog.array_length(names, 1))::integer
  ]
  from (
    values (array[
      '雪豹', '赤狐', '海獭', '猞猁', '兔狲', '水豚', '羊驼', '驯鹿',
      '长颈鹿', '斑马', '亚洲象', '大熊猫', '小熊猫', '金丝猴', '环尾狐猴', '树懒',
      '蓝鲸', '白鲸', '海豚', '儒艮', '座头鲸', '信天翁', '蜂鸟', '朱鹮',
      '丹顶鹤', '火烈鸟', '雪鸮', '翠鸟', '雨燕', '帝企鹅', '绿孔雀', '琴鸟',
      '银杏', '水杉', '珙桐', '木棉', '榕树', '白桦', '雪松', '红杉',
      '猴面包树', '蓝花楹', '合欢', '玉兰', '山茶', '海棠', '木槿', '桂花',
      '睡莲', '鸢尾', '风信子', '铃兰', '向日葵', '蒲公英', '薰衣草', '迷迭香',
      '苔藓', '蕨类', '竹子', '芦苇', '龙舌兰', '仙人掌', '捕蝇草', '含羞草'
    ]::text[])
  ) as nickname_pool(names);
$$;

revoke execute on function private.random_profile_display_name()
  from public, anon, authenticated;

create or replace function public.ensure_profile_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.display_name := case
    when nullif(pg_catalog.btrim(new.display_name), '') is null
      then private.random_profile_display_name()
    else pg_catalog.btrim(new.display_name)
  end;
  return new;
end;
$$;

revoke execute on function public.ensure_profile_display_name()
  from public, anon, authenticated;

drop trigger if exists profiles_ensure_display_name on public.profiles;
create trigger profiles_ensure_display_name
  before insert or update of display_name on public.profiles
  for each row execute function public.ensure_profile_display_name();

update public.profiles
set display_name = private.random_profile_display_name()
where nullif(pg_catalog.btrim(display_name), '') is null;

alter table public.profiles
  alter column display_name set not null;

alter table public.profiles
  drop constraint if exists profiles_display_name_check;

alter table public.profiles
  add constraint profiles_display_name_check
  check (
    pg_catalog.char_length(pg_catalog.btrim(display_name)) between 1 and 50
  );

comment on column public.profiles.display_name is
  'Editable reader nickname; generated from the animal and plant name pool when omitted.';
