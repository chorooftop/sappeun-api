export const MAX_CLIP_DESCRIPTION_LENGTH = 160
export const MAX_PHOTO_SIZE_BYTES = 5 * 1024 * 1024
export const MAX_CLIP_DURATION_GRACE_MS = 3000
export const MAX_CLIP_SIZE_BYTES = 12 * 1024 * 1024
export const MAX_POSTER_SIZE_BYTES = 500 * 1024
export const SIGNED_UPLOAD_EXPIRES_SECONDS = 60 * 60 * 2
export const SIGNED_PREVIEW_EXPIRES_SECONDS = 60 * 10

export const SUPPORTED_PHOTO_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const

export const SUPPORTED_CLIP_CONTENT_TYPES = ['video/mp4', 'video/webm'] as const
export const SUPPORTED_POSTER_CONTENT_TYPES = [
  'image/jpeg',
  'image/webp',
] as const
