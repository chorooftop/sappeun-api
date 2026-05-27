import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { randomBytes } from 'node:crypto'

import { SupabaseService } from '@/supabase/supabase.service'

const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const SHARE_CODE_LENGTH = 8

function generateShareCode(length = SHARE_CODE_LENGTH) {
  const bytes = randomBytes(length)
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += SHARE_CODE_ALPHABET[bytes[i] % SHARE_CODE_ALPHABET.length]
  }
  return code
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function getShareUrl(shareCode: string, origin?: string | null) {
  const siteUrl = withoutTrailingSlash(
    process.env.NEXT_PUBLIC_SITE_URL || origin || 'http://localhost:3000',
  )
  return `${siteUrl}/share/${shareCode}`
}

function getShareOgImageUrl(origin?: string | null) {
  const siteUrl = withoutTrailingSlash(
    process.env.NEXT_PUBLIC_SITE_URL || origin || 'http://localhost:3000',
  )
  return `${siteUrl}/share/opengraph-image`
}

@Injectable()
export class SharesService {
  constructor(private readonly supabase: SupabaseService) {}

  private get admin() {
    return this.supabase.adminClient
  }

  async createBoardShare(
    userId: string,
    boardId: string,
    origin?: string | null,
  ) {
    await this.assertSignupCompleted(userId)

    const { data: board, error: boardError } = await this.admin
      .from('boards')
      .select('id, ended_at')
      .eq('id', boardId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (boardError) throw boardError
    if (!board) throw new NotFoundException('Board not found.')
    if (!board.ended_at) {
      throw new ForbiddenException('Only ended boards can be shared.')
    }

    const existing = await this.getExistingShare(board.id)
    const shareCode = existing?.share_code ?? (await this.insertShare(board.id))

    return {
      shareCode,
      shareUrl: getShareUrl(shareCode, origin),
      ogImageUrl: getShareOgImageUrl(origin),
    }
  }

  async deleteBoardShare(userId: string, boardId: string) {
    await this.assertSignupCompleted(userId)

    const { data: board, error: boardError } = await this.admin
      .from('boards')
      .select('id')
      .eq('id', boardId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (boardError) throw boardError
    if (!board) throw new NotFoundException('Board not found.')

    const { error } = await this.admin
      .from('shares')
      .delete()
      .eq('board_id', board.id)
    if (error) throw error

    return { ok: true }
  }

  private async assertSignupCompleted(userId: string) {
    const { data: profile, error } = await this.admin
      .from('profiles')
      .select('signup_completed_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!profile?.signup_completed_at) {
      throw new ForbiddenException('Signup required.')
    }
  }

  private async getExistingShare(boardId: string) {
    const { data, error } = await this.admin
      .from('shares')
      .select('board_id, share_code, created_at')
      .eq('board_id', boardId)
      .maybeSingle()

    if (error) throw error
    return data
  }

  private async insertShare(boardId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const shareCode = generateShareCode()
      const { error } = await this.admin
        .from('shares')
        .insert({ board_id: boardId, share_code: shareCode })

      if (!error) return shareCode

      if (error.code === '23505') {
        const racedExisting = await this.getExistingShare(boardId)
        if (racedExisting) return racedExisting.share_code
        continue
      }

      throw error
    }

    throw new Error('Unable to generate a unique share code.')
  }
}
