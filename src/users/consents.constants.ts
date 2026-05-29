export const CONSENT_TYPES = ['terms', 'privacy', 'marketing'] as const
export type ConsentType = (typeof CONSENT_TYPES)[number]

// 가입 시 반드시 동의해야 하는 항목
export const REQUIRED_CONSENT_TYPES = ['terms', 'privacy'] as const

// 현재 유효한 동의 버전.
// ⚠️ 필수 동의(terms, privacy) 버전은 DB 트리거 require_current_consents_for_signup()와
//    반드시 일치해야 한다. 버전을 올릴 때는 트리거와 이 상수를 함께 갱신할 것.
export const CURRENT_CONSENT_VERSIONS: Record<ConsentType, string> = {
  terms: 'terms-2026-05-16',
  privacy: 'privacy-2026-05-16',
  marketing: 'marketing-2026-05-16',
}

// user_consents.source CHECK ∈ {signup, login_recovery}
export const CONSENT_SOURCE_SIGNUP = 'signup'

// 만 나이 기준 가입 최소 연령(개인정보보호법: 만 14세 미만 차단, DEC-4)
export const MIN_SIGNUP_AGE = 14

// 만 나이 계산 (생년월일 기준, 기준일 default = 오늘).
// 호스트 시간대에 따른 경계 오차를 피하기 위해 UTC getter로 일관 계산한다.
export function calculateAge(birthDate: Date, asOf: Date = new Date()): number {
  let age = asOf.getUTCFullYear() - birthDate.getUTCFullYear()
  const monthDiff = asOf.getUTCMonth() - birthDate.getUTCMonth()
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && asOf.getUTCDate() < birthDate.getUTCDate())
  ) {
    age -= 1
  }
  return age
}
