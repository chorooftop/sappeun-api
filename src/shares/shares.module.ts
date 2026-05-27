import { Module } from '@nestjs/common'

import { SharesController } from '@/shares/shares.controller'

@Module({
  controllers: [SharesController],
})
export class SharesModule {}
