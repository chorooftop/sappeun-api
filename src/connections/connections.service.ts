import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { randomBytes } from 'node:crypto'

import {
  GROUP_MAX_MEMBERS,
  GROUP_MAX_PER_USER,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_TTL_DAYS,
} from '@/connections/connections.constants'
import type { CreateGroupInput } from '@/connections/connections.schemas'
import { SupabaseService } from '@/supabase/supabase.service'

export interface ConnectionGroupRow {
  id: string
  name: string
  relationship_label: string
  theme: string | null
  emoji: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface GroupMemberRow {
  group_id: string
  user_id: string
  joined_at: string
  left_at: string | null
}

export interface JoinRequestRow {
  id: string
  group_id: string
  user_id: string
  invite_id: string | null
  status: string
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

interface ProfileRow {
  user_id: string
  nickname: string | null
  display_name: string | null
}

const RPC_ERROR_TOKENS = [
  'GROUP_LIMIT_EXCEEDED',
  'MEMBER_LIMIT_EXCEEDED',
  'INVITE_NOT_FOUND',
  'INVITE_EXPIRED',
  'GROUP_DELETED',
  'ALREADY_MEMBER',
  'REQUEST_NOT_FOUND',
  'NOT_GROUP_MEMBER',
] as const

type RpcErrorToken = (typeof RPC_ERROR_TOKENS)[number]

function rpcErrorToken(error: { message?: string }): RpcErrorToken | null {
  const message = error.message ?? ''
  return RPC_ERROR_TOKENS.find((token) => message.includes(token)) ?? null
}

export function mapConnectionsRpcError(error: { message?: string }): Error {
  switch (rpcErrorToken(error)) {
    case 'GROUP_LIMIT_EXCEEDED':
      return new UnprocessableEntityException({
        code: 'GROUP_LIMIT_EXCEEDED',
        message: `A user can join at most ${GROUP_MAX_PER_USER} groups.`,
      })
    case 'MEMBER_LIMIT_EXCEEDED':
      return new UnprocessableEntityException({
        code: 'MEMBER_LIMIT_EXCEEDED',
        message: `A group can have at most ${GROUP_MAX_MEMBERS} members.`,
      })
    case 'INVITE_NOT_FOUND':
      return new NotFoundException('Invite not found.')
    case 'INVITE_EXPIRED':
      return new GoneException({
        code: 'INVITE_EXPIRED',
        message: 'Invite code is expired or revoked.',
      })
    case 'GROUP_DELETED':
      return new NotFoundException('Group not found.')
    case 'ALREADY_MEMBER':
      return new ConflictException({
        code: 'ALREADY_MEMBER',
        message: 'Already an active member of this group.',
      })
    case 'REQUEST_NOT_FOUND':
      return new NotFoundException('Join request not found.')
    case 'NOT_GROUP_MEMBER':
      return new ForbiddenException('Not an active member of this group.')
    default:
      return error instanceof Error ? error : new Error(error.message)
  }
}

function generateInviteCode(length = INVITE_CODE_LENGTH) {
  const bytes = randomBytes(length)
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length]
  }
  return code
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function getInviteUrl(inviteCode: string, origin?: string | null) {
  const siteUrl = withoutTrailingSlash(
    process.env.NEXT_PUBLIC_SITE_URL || origin || 'http://localhost:3000',
  )
  return `${siteUrl}/invite/${inviteCode}`
}

function toGroupDto(row: ConnectionGroupRow) {
  return {
    id: row.id,
    name: row.name,
    relationshipLabel: row.relationship_label,
    theme: row.theme,
    emoji: row.emoji,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

function toMemberDto(row: GroupMemberRow, profile?: ProfileRow) {
  return {
    userId: row.user_id,
    joinedAt: row.joined_at,
    nickname: profile?.nickname ?? null,
    displayName: profile?.display_name ?? null,
  }
}

function toJoinRequestDto(row: JoinRequestRow, profile?: ProfileRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    nickname: profile?.nickname ?? null,
    displayName: profile?.display_name ?? null,
  }
}

@Injectable()
export class ConnectionsService {
  constructor(private readonly supabase: SupabaseService) {}

  private get admin() {
    return this.supabase.adminClient
  }

  protected now() {
    return new Date()
  }

  /**
   * App-layer active-membership guard (AC-13). RLS alone cannot cover the
   * service-role client, so every group-scoped entry point must call this
   * before touching group data. Non-members get 404 (existence hiding).
   */
  async assertActiveGroupMember(userId: string, groupId: string) {
    const { data, error } = await this.admin
      .from('connection_group_members')
      .select('group_id, user_id, joined_at, left_at')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) throw new NotFoundException('Group not found.')

    const { data: group, error: groupError } = await this.admin
      .from('connection_groups')
      .select(
        'id, name, relationship_label, theme, emoji, created_by, created_at, updated_at, deleted_at',
      )
      .eq('id', groupId)
      .is('deleted_at', null)
      .maybeSingle()

    if (groupError) throw groupError
    if (!group) throw new NotFoundException('Group not found.')

    return {
      membership: data as GroupMemberRow,
      group: group as ConnectionGroupRow,
    }
  }

  async createGroup(userId: string, input: CreateGroupInput) {
    const { data, error } = await this.admin.rpc('create_connection_group', {
      p_user_id: userId,
      p_name: input.name,
      p_label: input.relationshipLabel,
      p_theme: input.theme ?? null,
      p_emoji: input.emoji ?? null,
      p_max_groups: GROUP_MAX_PER_USER,
    })

    if (error) throw mapConnectionsRpcError(error)
    const row = (Array.isArray(data) ? data[0] : data) as ConnectionGroupRow
    return { group: toGroupDto(row) }
  }

  async listGroups(userId: string) {
    const { data: memberships, error } = await this.admin
      .from('connection_group_members')
      .select('group_id')
      .eq('user_id', userId)
      .is('left_at', null)

    if (error) throw error
    const groupIds = ((memberships ?? []) as { group_id: string }[]).map(
      (row) => row.group_id,
    )
    if (groupIds.length === 0) return { groups: [] }

    const { data: groups, error: groupsError } = await this.admin
      .from('connection_groups')
      .select(
        'id, name, relationship_label, theme, emoji, created_by, created_at, updated_at, deleted_at',
      )
      .in('id', groupIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    if (groupsError) throw groupsError

    const { data: members, error: membersError } = await this.admin
      .from('connection_group_members')
      .select('group_id')
      .in('group_id', groupIds)
      .is('left_at', null)

    if (membersError) throw membersError

    const counts = new Map<string, number>()
    for (const row of (members ?? []) as { group_id: string }[]) {
      counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1)
    }

    return {
      groups: ((groups ?? []) as ConnectionGroupRow[]).map((row) => ({
        ...toGroupDto(row),
        memberCount: counts.get(row.id) ?? 0,
      })),
    }
  }

  async getGroup(userId: string, groupId: string) {
    const { group } = await this.assertActiveGroupMember(userId, groupId)

    const { data: members, error } = await this.admin
      .from('connection_group_members')
      .select('group_id, user_id, joined_at, left_at')
      .eq('group_id', groupId)
      .is('left_at', null)
      .order('joined_at', { ascending: true })

    if (error) throw error
    const memberRows = (members ?? []) as GroupMemberRow[]
    const profiles = await this.getProfiles(memberRows.map((m) => m.user_id))

    return {
      group: toGroupDto(group),
      members: memberRows.map((row) => toMemberDto(row, profiles.get(row.user_id))),
    }
  }

  async leaveGroup(userId: string, groupId: string) {
    const { data, error } = await this.admin.rpc('leave_group', {
      p_user_id: userId,
      p_group_id: groupId,
    })

    if (error) {
      // Leaving a group the caller is not part of reads as "not found".
      if (rpcErrorToken(error) === 'NOT_GROUP_MEMBER') {
        throw new NotFoundException('Group not found.')
      }
      throw mapConnectionsRpcError(error)
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { group_deleted: boolean }
      | undefined
    return { ok: true, groupDeleted: row?.group_deleted ?? false }
  }

  async createInvite(userId: string, groupId: string, origin?: string | null) {
    await this.assertActiveGroupMember(userId, groupId)

    const expiresAt = new Date(
      this.now().getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inviteCode = generateInviteCode()
      const { data, error } = await this.admin
        .from('connection_group_invites')
        .insert({
          group_id: groupId,
          invite_code: inviteCode,
          created_by: userId,
          expires_at: expiresAt,
        })
        .select('id, invite_code, expires_at')
        .maybeSingle()

      if (!error && data) {
        return {
          inviteId: data.id as string,
          inviteCode,
          inviteUrl: getInviteUrl(inviteCode, origin),
          expiresAt,
        }
      }

      if (error && error.code === '23505') continue
      if (error) throw error
    }

    throw new Error('Unable to generate a unique invite code.')
  }

  async revokeInvite(userId: string, groupId: string, inviteId: string) {
    await this.assertActiveGroupMember(userId, groupId)

    const { data, error } = await this.admin
      .from('connection_group_invites')
      .update({ revoked_at: this.now().toISOString() })
      .eq('id', inviteId)
      .eq('group_id', groupId)
      .is('revoked_at', null)
      .select('id')

    if (error) throw error
    if (!data || data.length === 0) {
      throw new NotFoundException('Invite not found.')
    }
    return { ok: true }
  }

  async requestJoin(userId: string, inviteCode: string) {
    const { data, error } = await this.admin.rpc('request_group_join', {
      p_user_id: userId,
      p_invite_code: inviteCode,
      p_max_groups: GROUP_MAX_PER_USER,
    })

    if (error) throw mapConnectionsRpcError(error)
    const row = (Array.isArray(data) ? data[0] : data) as JoinRequestRow
    return { request: toJoinRequestDto(row) }
  }

  async listJoinRequests(userId: string, groupId: string) {
    await this.assertActiveGroupMember(userId, groupId)

    const { data, error } = await this.admin
      .from('connection_group_join_requests')
      .select(
        'id, group_id, user_id, invite_id, status, decided_by, decided_at, created_at',
      )
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    if (error) throw error
    const rows = (data ?? []) as JoinRequestRow[]
    const profiles = await this.getProfiles(rows.map((row) => row.user_id))

    return {
      requests: rows.map((row) =>
        toJoinRequestDto(row, profiles.get(row.user_id)),
      ),
    }
  }

  async approveJoinRequest(deciderId: string, requestId: string) {
    const { data, error } = await this.admin.rpc('approve_group_join', {
      p_decider_id: deciderId,
      p_request_id: requestId,
      p_max_members: GROUP_MAX_MEMBERS,
      p_max_groups: GROUP_MAX_PER_USER,
    })

    if (error) throw mapConnectionsRpcError(error)
    const row = (Array.isArray(data) ? data[0] : data) as GroupMemberRow
    return {
      ok: true,
      member: {
        groupId: row.group_id,
        userId: row.user_id,
        joinedAt: row.joined_at,
      },
    }
  }

  async rejectJoinRequest(deciderId: string, requestId: string) {
    const { error } = await this.admin.rpc('reject_group_join', {
      p_decider_id: deciderId,
      p_request_id: requestId,
    })

    if (error) throw mapConnectionsRpcError(error)
    return { ok: true }
  }

  private async getProfiles(userIds: readonly string[]) {
    const profiles = new Map<string, ProfileRow>()
    if (userIds.length === 0) return profiles

    const { data, error } = await this.admin
      .from('profiles')
      .select('user_id, nickname, display_name')
      .in('user_id', [...userIds])

    if (error) throw error
    for (const row of (data ?? []) as ProfileRow[]) {
      profiles.set(row.user_id, row)
    }
    return profiles
  }
}
