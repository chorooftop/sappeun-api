const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function parseKstDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid KST date: ${value}`)

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
}

export type BoardLifecycle = 'active' | 'grace' | 'expired'

export interface BoardLifecycleResult {
  state: BoardLifecycle
  graceUntil: Date
}

export function kstDateOf(utc: Date): string {
  return new Date(utc.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10)
}

export function previousKstDate(dailyDate: string): string {
  const { year, month, day } = parseKstDate(dailyDate)
  return new Date(Date.UTC(year, month - 1, day) - DAY_MS)
    .toISOString()
    .slice(0, 10)
}

export function kstGraceUntil(dailyDate: string): Date {
  const { year, month, day } = parseKstDate(dailyDate)
  return new Date(Date.UTC(year, month - 1, day + 1, 1 - 9, 0, 0, 0))
}

export function kstNextDayStartsAt(dailyDate: string): Date {
  const { year, month, day } = parseKstDate(dailyDate)
  return new Date(Date.UTC(year, month - 1, day + 1, 0 - 9, 0, 0, 0))
}

export function computeLifecycle(
  dailyDate: string,
  now: Date,
): BoardLifecycleResult {
  const nextDayStartsAt = kstNextDayStartsAt(dailyDate)
  const graceUntil = kstGraceUntil(dailyDate)

  if (now.getTime() < nextDayStartsAt.getTime()) {
    return { state: 'active', graceUntil }
  }

  if (now.getTime() < graceUntil.getTime()) {
    return { state: 'grace', graceUntil }
  }

  return { state: 'expired', graceUntil }
}
