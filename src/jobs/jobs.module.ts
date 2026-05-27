import { Module } from '@nestjs/common'

import {
  JobsCompatibilityController,
  JobsController,
} from '@/jobs/jobs.controller'
import { MediaModule } from '@/media/media.module'

@Module({
  imports: [MediaModule],
  controllers: [JobsController, JobsCompatibilityController],
})
export class JobsModule {}
