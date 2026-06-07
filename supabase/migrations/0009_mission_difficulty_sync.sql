-- 0009_mission_difficulty_sync.sql
-- Sync mission_badges difficulty with sappeun-frontend sheet.json (v1.3.0,
-- difficulty-updated). The 0006 catalog seed predated the per-mission
-- difficulty edits, so 11 missions that are now medium/hard in sheet.json were
-- still seeded as 'easy'. This brings the DB catalog in line.
--
-- catalog_version stays 'api-migration-v1' (0006 anticipated future overrides).
-- Keeping the same version means already-earned user_badges automatically
-- resolve to the corrected difficulty/grade via the mission_badges join — no
-- badge re-issuance needed.
--
-- grade_label / grade_color follow the 0006 mapping:
--   medium → '도전 배지', '#F5A623'
--   hard   → '탐험 배지', '#E05353'
--
-- sheet.json difficulty (non-easy) → mission_id:
--   medium: n06 구름, m03 공중전화, m04 우체통, m09 벽화, a06 물고기,
--           t05 달, c07 검은색, c08 알록달록   (sf06/sf07 already medium in 0006)
--   hard:   n08 무지개, a04 나비, t06 별
-- Idempotent: re-running sets the same fixed values.

update public.mission_badges
   set difficulty  = 'medium',
       grade_label = '도전 배지',
       grade_color = '#F5A623'
 where catalog_version = 'api-migration-v1'
   and mission_id in ('n06', 'm03', 'm04', 'm09', 'a06', 't05', 'c07', 'c08');

update public.mission_badges
   set difficulty  = 'hard',
       grade_label = '탐험 배지',
       grade_color = '#E05353'
 where catalog_version = 'api-migration-v1'
   and mission_id in ('n08', 'a04', 't06');
