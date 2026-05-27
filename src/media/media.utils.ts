import { BadRequestException } from '@nestjs/common'

import {
  SUPPORTED_CLIP_CONTENT_TYPES,
  SUPPORTED_PHOTO_CONTENT_TYPES,
  SUPPORTED_POSTER_CONTENT_TYPES,
} from '@/media/media.constants'

export function signedUrlExpiresAt(expiresInSeconds: number, now = Date.now()) {
  return new Date(now + expiresInSeconds * 1000).toISOString()
}

export function photoExtFromContentType(contentType: string) {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (!SUPPORTED_PHOTO_CONTENT_TYPES.includes(base as never)) {
    throw new BadRequestException('Unsupported photo content type.')
  }
  if (base === 'image/jpeg') return 'jpg'
  if (base === 'image/png') return 'png'
  if (base === 'image/webp') return 'webp'
  return 'heic'
}

export function clipExtFromContentType(contentType: string) {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (!SUPPORTED_CLIP_CONTENT_TYPES.includes(base as never)) {
    throw new BadRequestException('Unsupported clip content type.')
  }
  return base === 'video/mp4' ? 'mp4' : 'webm'
}

export function posterExtFromContentType(contentType: string) {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (!SUPPORTED_POSTER_CONTENT_TYPES.includes(base as never)) {
    throw new BadRequestException('Unsupported poster content type.')
  }
  return base === 'image/webp' ? 'webp' : 'jpg'
}

export function normalizeClipContentType(value: string) {
  const base = value.split(';', 1)[0]?.trim().toLowerCase()
  if (base === 'video/mp4' || base === 'video/webm') return base
  return null
}

export function codecFromMimeType(value: string) {
  const codecs = value
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith('codecs='))
  return codecs?.slice('codecs='.length).replace(/^"|"$/g, '') || null
}
