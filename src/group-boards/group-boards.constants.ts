export const GROUP_BOARD_MODE = '3x3' as const
export const GROUP_BOARD_SIZE = 9
export const GROUP_BOARD_FREE_POSITION = 4
export const GROUP_REROLL_LIMIT = 3

export function groupBingoEnabled() {
  return process.env.GROUP_BINGO_ENABLED !== 'false'
}
