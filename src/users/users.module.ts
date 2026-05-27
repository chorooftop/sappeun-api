import { Module } from '@nestjs/common'

import {
  ProfileCompatibilityController,
  UsersController,
} from '@/users/users.controller'
import { UsersService } from '@/users/users.service'

@Module({
  controllers: [UsersController, ProfileCompatibilityController],
  providers: [UsersService],
})
export class UsersModule {}
