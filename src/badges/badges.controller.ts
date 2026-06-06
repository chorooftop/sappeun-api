import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { BadgesService } from '@/badges/badges.service'
import {
  userBadgesQuerySchema,
  type UserBadgesQueryInput,
} from '@/badges/badges.schemas'

function parseUserBadgesQuery(query: unknown): UserBadgesQueryInput {
  const parsed = userBadgesQuerySchema.safeParse(query)
  if (parsed.success) return parsed.data

  throw new BadRequestException({
    error: 'Invalid request query.',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  })
}

@Controller('badges')
export class BadgesCatalogController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get('catalog')
  @UseGuards(SupabaseAuthGuard)
  async catalog() {
    return { badges: await this.badgesService.listCatalog() }
  }
}

@Controller('users/me/badges')
export class UserBadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get()
  @UseGuards(SupabaseAuthGuard)
  async list(@CurrentUser() user: User, @Query() query: unknown) {
    return this.badgesService.listUserBadges(
      user.id,
      parseUserBadgesQuery(query),
    )
  }

  @Get(':badgeId')
  @UseGuards(SupabaseAuthGuard)
  async detail(
    @CurrentUser() user: User,
    @Param('badgeId') badgeId: string,
  ) {
    const badge = await this.badgesService.getUserBadgeDetail(user.id, badgeId)
    if (!badge) throw new NotFoundException('Badge not found.')
    return { badge }
  }
}
