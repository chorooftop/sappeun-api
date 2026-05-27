import { Module } from '@nestjs/common'

import {
  SharesCompatibilityController,
  SharesController,
} from '@/shares/shares.controller'
import { SharesService } from '@/shares/shares.service'

@Module({
  controllers: [SharesController, SharesCompatibilityController],
  providers: [SharesService],
})
export class SharesModule {}
