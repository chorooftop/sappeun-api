-- 0007_bingo_badge_fk_indexes.sql
-- Forward-fix for Supabase performance advisor after 0006.
-- Adds covering indexes for badge-table foreign keys that are not covered by
-- the existing primary keys / board_badges_user_board_idx.

create index if not exists board_badges_badge_idx
  on public.board_badges (badge_id);

create index if not exists user_badges_badge_idx
  on public.user_badges (badge_id);

create index if not exists user_badges_first_board_idx
  on public.user_badges (first_board_id);

create index if not exists user_badges_last_board_idx
  on public.user_badges (last_board_id);
