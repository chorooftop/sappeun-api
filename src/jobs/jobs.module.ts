import { Module } from '@nestjs/common'

import { JobsController } from '@/jobs/jobs.controller'

@Module({
  controllers: [JobsController],
})
export class JobsModule {}
