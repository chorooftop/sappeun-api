import { Module } from '@nestjs/common'

import {
  BadgesCatalogController,
  UserBadgesController,
} from '@/badges/badges.controller'
import { BadgesService } from '@/badges/badges.service'

@Module({
  controllers: [BadgesCatalogController, UserBadgesController],
  providers: [BadgesService],
  exports: [BadgesService],
})
export class BadgesModule {}
