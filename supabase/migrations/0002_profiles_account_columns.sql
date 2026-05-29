-- Phase 1: 계정 생애주기 컬럼 추가
-- - birth_date: 연령 게이트(만 14세 미만 차단, DEC-4)
-- - deleted_at / deletion_reason / purge_scheduled_at: soft delete + 유예 파기(DEC-1, Phase 2에서 사용)
-- idempotent: add column if not exists

alter table public.profiles
  add column if not exists birth_date         date,
  add column if not exists deleted_at          timestamptz,
  add column if not exists deletion_reason     text,
  add column if not exists purge_scheduled_at  timestamptz;

-- 유예 파기 cron 조회용 인덱스 (Phase 2 사용처). deleted_at 있는 행만.
create index if not exists profiles_purge_scheduled_idx
  on public.profiles (purge_scheduled_at)
  where deleted_at is not null;
