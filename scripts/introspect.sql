-- Phase 0 심화 진단: RLS / FK on-delete / 기본값 / 제약
-- 실행: psql "$DB_URL" -f scripts/introspect.sql
\pset pager off

\echo '===== 1. 계정 테이블 RLS 활성화 여부 ====='
select c.relname as table, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('profiles','user_consents','account_deletions','boards','board_cells','photos','clips','shares','guest_photo_uploads','guest_clip_uploads')
order by c.relname;

\echo ''
\echo '===== 2. RLS 정책 (profiles, user_consents) ====='
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('profiles','user_consents')
order by tablename, policyname;

\echo ''
\echo '===== 3. profiles / user_consents FK (특히 auth.users on delete) ====='
select tc.table_name, tc.constraint_name, kcu.column_name,
       ccu.table_schema as ref_schema, ccu.table_name as ref_table, ccu.column_name as ref_col,
       rc.delete_rule, rc.update_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  and tc.table_name in ('profiles','user_consents')
order by tc.table_name;

\echo ''
\echo '===== 4. profiles 컬럼 기본값/NULL 허용 ====='
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

\echo ''
\echo '===== 5. user_consents 컬럼 기본값/NULL + 제약 ====='
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'user_consents'
order by ordinal_position;

\echo ''
\echo '===== 6. user_consents 유니크/PK/CHECK 제약 ====='
select conname, contype,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.user_consents'::regclass
order by contype;

\echo ''
\echo '===== 7. profiles CHECK/UNIQUE 제약 ====='
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.profiles'::regclass
order by contype;

\echo ''
\echo '===== 8. profiles 트리거 (updated_at 자동갱신 등) ====='
select tgname, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.profiles'::regclass and not tgisinternal;
