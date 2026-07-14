import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@supabase/supabase-js'
import type { Request } from 'express'

import { CurrentUser } from '@/auth/current-user.decorator'
import { SupabaseAuthGuard } from '@/auth/supabase-auth.guard'
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'
import {
  createGroupSchema,
  joinRequestSchema,
  type CreateGroupInput,
  type JoinRequestInput,
} from '@/connections/connections.schemas'
import { ConnectionsService } from '@/connections/connections.service'

@Controller('connections')
@UseGuards(SupabaseAuthGuard)
export class ConnectionsController {
  constructor(private readonly connectionsService: ConnectionsService) {}

  @Post('groups')
  async createGroup(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(createGroupSchema)) input: CreateGroupInput,
  ) {
    return this.connectionsService.createGroup(user.id, input)
  }

  @Get('groups')
  async listGroups(@CurrentUser() user: User) {
    return this.connectionsService.listGroups(user.id)
  }

  @Get('groups/:groupId')
  async getGroup(@CurrentUser() user: User, @Param('groupId') groupId: string) {
    return this.connectionsService.getGroup(user.id, groupId)
  }

  @Delete('groups/:groupId/membership')
  async leaveGroup(
    @CurrentUser() user: User,
    @Param('groupId') groupId: string,
  ) {
    return this.connectionsService.leaveGroup(user.id, groupId)
  }

  @Post('groups/:groupId/invites')
  async createInvite(
    @CurrentUser() user: User,
    @Param('groupId') groupId: string,
    @Req() request: Request,
  ) {
    return this.connectionsService.createInvite(
      user.id,
      groupId,
      `${request.protocol}://${request.get('host')}`,
    )
  }

  @Delete('groups/:groupId/invites/:inviteId')
  async revokeInvite(
    @CurrentUser() user: User,
    @Param('groupId') groupId: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.connectionsService.revokeInvite(user.id, groupId, inviteId)
  }

  @Post('join-requests')
  async requestJoin(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(joinRequestSchema)) input: JoinRequestInput,
  ) {
    return this.connectionsService.requestJoin(user.id, input.inviteCode)
  }

  @Get('groups/:groupId/join-requests')
  async listJoinRequests(
    @CurrentUser() user: User,
    @Param('groupId') groupId: string,
  ) {
    return this.connectionsService.listJoinRequests(user.id, groupId)
  }

  @Post('join-requests/:requestId/approve')
  async approveJoinRequest(
    @CurrentUser() user: User,
    @Param('requestId') requestId: string,
  ) {
    return this.connectionsService.approveJoinRequest(user.id, requestId)
  }

  @Post('join-requests/:requestId/reject')
  async rejectJoinRequest(
    @CurrentUser() user: User,
    @Param('requestId') requestId: string,
  ) {
    return this.connectionsService.rejectJoinRequest(user.id, requestId)
  }
}
