import { Module } from '@nestjs/common'

import { QaAuthController } from '@/qa-auth/qa-auth.controller'
import { QaAuthService } from '@/qa-auth/qa-auth.service'
import { UsersModule } from '@/users/users.module'

@Module({
  imports: [UsersModule],
  controllers: [QaAuthController],
  providers: [QaAuthService],
})
export class QaAuthModule {}
