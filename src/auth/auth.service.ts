import { Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'

import {
  INVALID_AUTHORIZATION_HEADER_MESSAGE,
  INVALID_BEARER_TOKEN_MESSAGE,
} from '@/auth/auth.constants'
import type { CurrentUserLookup } from '@/auth/auth.types'
import { SupabaseService } from '@/supabase/supabase.service'

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
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
}
