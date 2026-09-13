begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(22);
select extensions.has_function('public', 'get_public_book_annotations', array['text','uuid','integer'], 'public book notes expose a bounded page RPC');
select extensions.ok(has_function_privilege('authenticated','public.get_public_book_annotations(text,uuid,integer)','execute'), 'authenticated access');
select extensions.ok(not has_function_privilege('anon','public.get_public_book_annotations(text,uuid,integer)','execute'), 'anonymous access is denied');
select extensions.ok(not exists (select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.get_public_book_annotations(text,uuid,integer)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'), 'PUBLIC has no execute permission');
select extensions.has_index('public','content_annotations','content_annotations_visible_book_page','book cursor index exists');
select extensions.has_index('public','content_annotation_marks','content_annotation_marks_reader_anchor','reader mark index exists');
select extensions.has_index('public','annotation_comments','annotation_comments_reader_visible_anchor','reader thought index exists');
select extensions.has_index('public','annotation_comments','annotation_comments_public_visible_anchor','public thought lookup index exists');
set local session_replication_role = replica;
insert into auth.users(id, email) values
 ('00000000-0000-4000-9000-000000009301', 'book-notes-owner@example.invalid'),
 ('00000000-0000-4000-9000-000000009302', 'book-notes-other@example.invalid'),
 ('00000000-0000-4000-9000-000000009303', 'book-notes-empty@example.invalid');
set local session_replication_role = origin;

select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select extensions.throws_ok($$select public.get_public_book_annotations('notes-book')$$,'42501','Authentication is required','auth required');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000009301',true);
select extensions.throws_ok($$select public.get_public_book_annotations('notes-book',null,101)$$,'22023','Book annotation limit must be between 1 and 100','limit bounded');
insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key, moderation_status, created_at)
select ('00000000-0000-4000-9000-' || lpad(number::text, 12, '0'))::uuid,
  content_type, content_id, 'chapter-' || number, '测试书',
  case when number = 9314 then '00000000-0000-4000-9000-000000009301'::uuid
    else '00000000-0000-4000-9000-000000009302'::uuid end,
  '原文 ' || number, repeat(md5(number::text), 2), moderation_status,
  '2026-09-01'::timestamptz - (number - 9310) * interval '1 day'
from (values
  (9310, 'book', 'notes-book', 'visible'), -- A's mark on an anchor first created by B
  (9311, 'book', 'notes-book', 'visible'), -- A's private thought without any mark
  (9312, 'book', 'notes-book', 'visible'), -- A's mark and public thought count as one thread
  (9314, 'book', 'notes-book', 'visible'), -- Being the original author is not a current mark
  (9315, 'book', 'notes-book', 'visible'), -- Only B's public thought
  (9316, 'book', 'notes-book', 'visible'), -- Only B's private thought
  (9317, 'book', 'notes-book', 'hidden'),  -- A's mark and thought on a moderated anchor
  (9318, 'book', 'notes-book', 'visible'), -- Only A's moderated thought
  (9319, 'book', 'another-book', 'visible'),
  (9320, 'newspaper', 'notes-book', 'visible'),
  (9321, 'magazine', 'notes-book', 'visible'),
  (9322, 'article', 'notes-book', 'visible'),
  (9323, 'book', 'notes-book', 'visible')  -- Mixed authors and comment visibility
) fixture(number, content_type, content_id, moderation_status);

insert into public.content_annotation_marks(annotation_id, user_id)
select ('00000000-0000-4000-9000-' || lpad(number::text, 12, '0'))::uuid,
  '00000000-0000-4000-9000-000000009301'::uuid
from unnest(array[9310, 9312, 9317, 9319, 9320, 9321, 9322, 9323]) number;

insert into public.annotation_comments(id, annotation_id, user_id, body, visibility, moderation_status, created_at)
select ('00000000-0000-4000-9000-' || lpad(number::text, 12, '0'))::uuid,
  ('00000000-0000-4000-9000-' || lpad(annotation_number::text, 12, '0'))::uuid,
  ('00000000-0000-4000-9000-' || lpad(reader_number::text, 12, '0'))::uuid,
  '想法 ' || number, visibility, moderation_status, '2026-09-01'::timestamptz
from (values
  (9511, 9311, 9301, 'private', 'visible'),
  (9512, 9312, 9301, 'public', 'visible'),
  (9515, 9315, 9302, 'public', 'visible'),
  (9516, 9316, 9302, 'private', 'visible'),
  (9517, 9317, 9301, 'private', 'visible'),
  (9518, 9318, 9301, 'public', 'hidden'),
  (9523, 9323, 9301, 'public', 'visible'),
  (9524, 9323, 9301, 'private', 'visible'),
  (9525, 9323, 9301, 'private', 'hidden'),
  (9526, 9323, 9302, 'public', 'visible'),
  (9527, 9323, 9302, 'private', 'visible'),
  (9528, 9323, 9302, 'public', 'hidden')
) fixture(number, annotation_number, reader_number, visibility, moderation_status);
update public.annotation_comments set parent_comment_id = '00000000-0000-4000-9000-000000009526'
where id = '00000000-0000-4000-9000-000000009524';
insert into public.annotation_comment_likes(comment_id, user_id) values
 ('00000000-0000-4000-9000-000000009523', '00000000-0000-4000-9000-000000009301'),
 ('00000000-0000-4000-9000-000000009523', '00000000-0000-4000-9000-000000009302');


-- A second reader makes the plain underline public under the existing threshold.
insert into public.content_annotation_marks(annotation_id,user_id) values ('00000000-0000-4000-9000-000000009310','00000000-0000-4000-9000-000000009302');
create temporary table public_notes_result as select public.get_public_book_annotations('notes-book') as threads;
select extensions.is((select jsonb_agg(t->>'id' order by pos) from public_notes_result,jsonb_array_elements(threads) with ordinality j(t,pos)), '["00000000-0000-4000-9000-000000009310","00000000-0000-4000-9000-000000009312","00000000-0000-4000-9000-000000009315","00000000-0000-4000-9000-000000009323"]'::jsonb,'all publicly visible notes across chapters, excluding private-only and hidden records');
select extensions.ok((select bool_and(c->>'visibility'='public') from public_notes_result,jsonb_array_elements(threads) t,jsonb_array_elements(t->'comments') c),'even own private thoughts are excluded from public results');
select extensions.is((select jsonb_agg(c->>'id' order by pos) from public_notes_result,jsonb_array_elements(threads #> '{3,comments}') with ordinality j(c,pos)),'["00000000-0000-4000-9000-000000009523","00000000-0000-4000-9000-000000009526"]'::jsonb,'public thoughts include both authors and retain reaction ranking');
select extensions.is(public.get_public_book_annotations('missing-book'),'[]'::jsonb,'empty public book');
select extensions.is(public.get_public_book_annotations('notes-book',null,2)||public.get_public_book_annotations('notes-book','00000000-0000-4000-9000-000000009312',2),(select threads from public_notes_result),'pages neither skip nor repeat notes');
select set_config('request.jwt.claim.sub','00000000-0000-4000-9000-000000009303',true);
select extensions.is(jsonb_array_length(public.get_public_book_annotations('notes-book')),4,'a reader with no own notes still sees all public notes');
select extensions.is(public.get_my_book_annotations('notes-book'),'[]'::jsonb,'personal view stays empty and isolated');
update private.feature_flags set config=jsonb_set(config,'{publicMarkThreshold}','3') where key='reader.annotations';
select extensions.is(jsonb_array_length(public.get_public_book_annotations('notes-book')),3,'public visibility follows the configured mark threshold');
set local role authenticated;
select extensions.is(jsonb_array_length(public.get_public_book_annotations('notes-book',null,1)),1,'definer RPC works without table access');
reset role;
insert into public.content_annotations(id, content_type, content_id, section_id, content_title, user_id, quote, anchor_key)
select ('00000000-0000-4000-9000-' || lpad((10000 + number)::text, 12, '0'))::uuid,
  'book', 'many-notes-book', 'chapter-' || number, '长书', '00000000-0000-4000-9000-000000009301'::uuid,
  '原文 ' || number, repeat(md5(number::text), 2)
from generate_series(1, 103) number;
insert into public.content_annotation_marks(annotation_id, user_id)
select id, '00000000-0000-4000-9000-000000009301'::uuid
from public.content_annotations where content_id = 'many-notes-book';

insert into public.content_annotation_marks(annotation_id,user_id) select id,'00000000-0000-4000-9000-000000009302'::uuid from public.content_annotations where content_id='many-notes-book';
update private.feature_flags set config=jsonb_set(config,'{publicMarkThreshold}','2') where key='reader.annotations';
select extensions.is(jsonb_array_length(public.get_public_book_annotations('many-notes-book')),100,'public default page is capped at 100');
select extensions.is(jsonb_array_length(public.get_public_book_annotations('many-notes-book','00000000-0000-4000-9000-000000010100')),3,'public next page returns the remainder');
select extensions.is(public.get_public_book_annotations('many-notes-book','00000000-0000-4000-9000-000000010103'),'[]'::jsonb,'public pagination terminates');
-- Diagnostic plans use synthetic data only; production timings are not inferred.
insert into public.content_annotations(id,content_type,content_id,section_id,content_title,user_id,quote,anchor_key)
select ('00000000-0000-4000-9000-'||lpad((20000+n)::text,12,'0'))::uuid,'book','plan-filler-'||(n%50),'c1','fixture','00000000-0000-4000-9000-000000009302'::uuid,'fixture '||n,repeat(md5(('plan-'||n)),2) from generate_series(1,5000) n;
insert into public.content_annotation_marks(annotation_id,user_id)
select id,'00000000-0000-4000-9000-000000009302'::uuid from public.content_annotations where content_id like 'plan-filler-%';
analyze public.content_annotations;
analyze public.content_annotation_marks;
analyze public.annotation_comments;
do $plans$
declare line record;
begin
  for line in execute $query$
    explain (analyze, buffers, costs off)
    select a.id from public.content_annotations a
    where a.content_type='book' and a.content_id='notes-book' and a.moderation_status='visible'
      and a.id > '00000000-0000-4000-9000-000000009310'
      and (exists (select 1 from public.annotation_comments c where c.annotation_id=a.id and c.visibility='public' and c.moderation_status='visible')
        or 2 <= (select count(*) from (select 1 from public.content_annotation_marks m where m.annotation_id=a.id limit 2) readers))
    order by a.id limit 100
  $query$ loop raise notice 'public book page plan: %', line; end loop;
  for line in execute $query$
    explain (analyze, buffers, costs off)
    with mine as (
      select annotation_id from public.content_annotation_marks where user_id='00000000-0000-4000-9000-000000009301' and annotation_id>'00000000-0000-4000-9000-000000009310'
      union select annotation_id from public.annotation_comments where user_id='00000000-0000-4000-9000-000000009301' and moderation_status='visible' and annotation_id>'00000000-0000-4000-9000-000000009310'
    ) select a.id from mine join public.content_annotations a on a.id=mine.annotation_id
    where a.content_type='book' and a.content_id='notes-book' and a.moderation_status='visible' and a.id>'00000000-0000-4000-9000-000000009310' order by a.id limit 100
  $query$ loop raise notice 'my book page plan: %', line; end loop;
end;
$plans$;

select * from extensions.finish();
rollback;
