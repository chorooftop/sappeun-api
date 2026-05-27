import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Request } from 'express'

import { CurrentUser } from '@/auth/current-user.decorator'
import { AuthService } from '@/auth/auth.service'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'
import { UsersService } from '@/users/users.service'

const updateProfileSchema = z.object({
  nickname: z.string().trim().min(1).max(10),
})

const authSyncSchema = z
  .object({
    provider: z.enum(['kakao', 'apple', 'google']).optional(),
    displayName: z.string().trim().min(1).max(40).optional(),
    avatarUrl: z.string().trim().url().max(2048).optional(),
  })
  .strict()
  .default({})

type AuthSyncInput = z.infer<typeof authSyncSchema>

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  getMe(@CurrentUser() user: User) {
    return this.usersService.getMe(user)
  }

  @Patch('me')
  @UseGuards(SupabaseAuthGuard)
  updateMe(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(updateProfileSchema))
    input: { nickname: string },
  ) {
    return this.usersService.updateNickname(user.id, input.nickname)
  }

  @Post('me/auth-sync')
  @UseGuards(SupabaseAuthGuard)
  syncAuthProfile(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(authSyncSchema))
    input: AuthSyncInput,
  ) {
    return this.usersService.syncAuthProfile(user, input)
  }
}

@Controller('api/profile')
export class ProfileCompatibilityController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Get()
  async getProfile(@Req() request: Request) {
    const user = await this.authService.requireUser(request)
    return this.usersService.getProfile(user)
  }

  @Patch()
  async updateProfile(
    @Req() request: Request,
    @Body(new ZodValidationPipe(updateProfileSchema))
    input: { nickname: string },
  ) {
    const user = await this.authService.requireUser(request)
    return this.usersService.updateNickname(user.id, input.nickname)
  }
}
