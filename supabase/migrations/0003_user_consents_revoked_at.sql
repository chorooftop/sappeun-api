-- Phase 1: 마케팅 동의(선택) 지원 (DEC-4)
-- - revoked_at: 마케팅 등 철회 가능 동의의 철회 시각(필수 동의는 NULL 유지)
-- - consent_type CHECK에 'marketing' 추가 (기존은 {terms, privacy}만 허용)
-- idempotent

alter table public.user_consents
  add column if not exists revoked_at timestamptz;

alter table public.user_consents
  drop constraint if exists user_consents_consent_type_check;

alter table public.user_consents
  add constraint user_consents_consent_type_check
  check (consent_type = any (array['terms'::text, 'privacy'::text, 'marketing'::text]));
