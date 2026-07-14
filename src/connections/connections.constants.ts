export const GROUP_MAX_PER_USER = 5
export const GROUP_MAX_MEMBERS = 6
export const INVITE_TTL_DAYS = 7

export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 8

export const RELATIONSHIP_LABELS = [
  'lover',
  'friend',
  'family',
  'custom',
] as const

export type RelationshipLabel = (typeof RELATIONSHIP_LABELS)[number]
