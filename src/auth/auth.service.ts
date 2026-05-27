import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'

import {
  INVALID_AUTHORIZATION_HEADER_MESSAGE,
  INVALID_BEARER_TOKEN_MESSAGE,
  INVALID_GUEST_SESSION_HEADER_MESSAGE,
  MOBILE_GUEST_SESSION_HEADER,
} from '@/auth/auth.constants'
import type { CurrentUserLookup, GuestSessionLookup } from '@/auth/auth.types'
import { SupabaseService } from '@/supabase/supabase.service'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export function normalizeGuestSessionId(
  value: string | null | undefined,
): string | null {
  const candidate = value?.trim()
  if (!candidate || !UUID_PATTERN.test(candidate)) return null
  return candidate
}

@Injectable()
export class AuthService {
  constructor(private readonly supabase: SupabaseService) {}

  getBearerToken(request: Request): string | null {
    const rawAuthorization = firstHeaderValue(request.headers.authorization)
    if (rawAuthorization === null) return null

    const parts = rawAuthorization.trim().split(/\s+/)
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
      throw new UnauthorizedException(INVALID_AUTHORIZATION_HEADER_MESSAGE)
    }

    const token = parts[1]?.trim()
    if (!token) {
      throw new UnauthorizedException(INVALID_AUTHORIZATION_HEADER_MESSAGE)
    }

    return token
  }

  async resolveUser(request: Request): Promise<CurrentUserLookup> {
    const token = this.getBearerToken(request)
    if (!token) return { user: null, source: 'none' }

    const {
      data: { user },
      error,
    } = await this.supabase.anonClient.auth.getUser(token)

    if (error || !user) {
      throw new UnauthorizedException(INVALID_BEARER_TOKEN_MESSAGE)
    }

    return { user, source: 'bearer' }
  }

  async requireUser(request: Request) {
    const { user } = await this.resolveUser(request)
    if (!user) throw new UnauthorizedException('Authentication required.')
    return user
  }

  getGuestSession(request: Request): GuestSessionLookup {
    const rawGuestSessionId = firstHeaderValue(
      request.headers[MOBILE_GUEST_SESSION_HEADER],
    )

    if (rawGuestSessionId === null) {
      return { guestSessionId: null, source: 'none' }
    }

    const guestSessionId = normalizeGuestSessionId(rawGuestSessionId)
    if (!guestSessionId) {
      throw new BadRequestException(INVALID_GUEST_SESSION_HEADER_MESSAGE)
    }

    return { guestSessionId, source: 'header' }
  }

  resolveOrCreateGuestSession(request: Request): GuestSessionLookup {
    const lookup = this.getGuestSession(request)
    if (lookup.guestSessionId) return lookup
    return { guestSessionId: randomUUID(), source: 'none' }
  }
}
