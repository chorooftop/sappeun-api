import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'
import type { Request } from 'express'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { BadgesService } from '@/badges/badges.service'
import { parseClientCapabilities } from '@/common/client-capabilities'
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
  async catalog(@Req() request: Request) {
    return {
      badges: await this.badgesService.listCatalog(
        parseClientCapabilities(request.headers),
      ),
    }
  }
}

@Controller('users/me/badges')
export class UserBadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  @Get()
  @UseGuards(SupabaseAuthGuard)
  async list(
    @CurrentUser() user: User,
    @Query() query: unknown,
    @Req() request: Request,
  ) {
    return this.badgesService.listUserBadges(
      user.id,
      parseUserBadgesQuery(query),
      parseClientCapabilities(request.headers),
    )
  }

  @Get(':badgeId')
  @UseGuards(SupabaseAuthGuard)
  async detail(
    @CurrentUser() user: User,
    @Param('badgeId') badgeId: string,
    @Req() request: Request,
  ) {
    const badge = await this.badgesService.getUserBadgeDetail(
      user.id,
      badgeId,
      parseClientCapabilities(request.headers),
    )
    if (!badge) throw new NotFoundException('Badge not found.')
    return { badge }
  }
}
