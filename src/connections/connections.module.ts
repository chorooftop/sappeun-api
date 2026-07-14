import { Module } from '@nestjs/common'

import { ConnectionsController } from '@/connections/connections.controller'
import { ConnectionsService } from '@/connections/connections.service'

@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
