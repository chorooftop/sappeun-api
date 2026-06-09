export const BADGE_GRADE = {
  easy: { label: '일상 배지', color: '#6ED6A0' },
  medium: { label: '도전 배지', color: '#F5A623' },
  hard: { label: '탐험 배지', color: '#E05353' },
} as const

export type BadgeDifficulty = keyof typeof BADGE_GRADE

export function badgeGradeForDifficulty(difficulty: string) {
  const grade = BADGE_GRADE[difficulty as BadgeDifficulty]
  if (!grade) {
    throw new Error(`Unsupported badge difficulty: ${difficulty}.`)
  }
  return grade
}
