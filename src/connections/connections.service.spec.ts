import { describe, expect, it } from 'vitest'

import {
  GROUP_MAX_MEMBERS,
  GROUP_MAX_PER_USER,
  INVITE_CODE_ALPHABET,
} from '@/connections/connections.constants'
import { joinRequestSchema } from '@/connections/connections.schemas'
import { ConnectionsService } from '@/connections/connections.service'

type QueryResult = {
  data: unknown
  error: (Error & { code?: string }) | null
}

type RpcCall = { name: string; args: Record<string, unknown> }

function makeQuery(result: QueryResult) {
  const query: Record<string, unknown> = {
    select: () => query,
    insert: () => query,
    update: () => query,
    eq: () => query,
    in: () => query,
    is: () => query,
    order: () => query,
    maybeSingle: () => Promise.resolve(result),
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function makeAdmin(
  queues: Record<string, QueryResult[]>,
  rpcQueue: QueryResult[] = [],
  rpcCalls: RpcCall[] = [],
) {
  return {
    from(table: string) {
      const next = queues[table]?.shift()
      if (!next) throw new Error(`Unexpected table query: ${table}`)
      return makeQuery(next)
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      const next = rpcQueue.shift()
      return Promise.resolve(next ?? { data: null, error: null })
    },
  }
}

function makeService(admin: ReturnType<typeof makeAdmin>) {
  return new ConnectionsService({ adminClient: admin } as never)
}

const GROUP_ROW = {
  id: 'group-1',
  name: '우리 가족',
  relationship_label: 'family',
  theme: null,
  emoji: null,
  created_by: 'user-1',
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  deleted_at: null,
}

const MEMBERSHIP_ROW = {
  group_id: 'group-1',
  user_id: 'user-1',
  joined_at: '2026-07-14T00:00:00.000Z',
  left_at: null,
}

function activeMembershipQueues(): Record<string, QueryResult[]> {
  return {
    connection_group_members: [{ data: MEMBERSHIP_ROW, error: null }],
    connection_groups: [{ data: GROUP_ROW, error: null }],
  }
}

describe('ConnectionsService', () => {
  describe('createGroup', () => {
    it('calls the RPC with the user cap and maps the returned group', async () => {
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin({}, [{ data: GROUP_ROW, error: null }], rpcCalls)
      const service = makeService(admin)

      const result = await service.createGroup('user-1', {
        name: '우리 가족',
        relationshipLabel: 'family',
      })

      expect(rpcCalls).toHaveLength(1)
      expect(rpcCalls[0].name).toBe('create_connection_group')
      expect(rpcCalls[0].args.p_max_groups).toBe(GROUP_MAX_PER_USER)
      expect(result.group).toMatchObject({
        id: 'group-1',
        name: '우리 가족',
        relationshipLabel: 'family',
      })
    })

    it('maps GROUP_LIMIT_EXCEEDED to a 422 domain error', async () => {
      const admin = makeAdmin({}, [
        { data: null, error: new Error('GROUP_LIMIT_EXCEEDED') },
      ])
      const service = makeService(admin)

      await expect(
        service.createGroup('user-1', {
          name: '우리 가족',
          relationshipLabel: 'family',
        }),
      ).rejects.toMatchObject({ status: 422 })
    })
  })

  describe('assertActiveGroupMember (AC-13 app-layer guard)', () => {
    it('rejects non-members with 404', async () => {
      const admin = makeAdmin({
        connection_group_members: [{ data: null, error: null }],
      })
      const service = makeService(admin)

      await expect(
        service.assertActiveGroupMember('outsider', 'group-1'),
      ).rejects.toMatchObject({ status: 404 })
    })

    it('rejects members of soft-deleted groups with 404', async () => {
      const admin = makeAdmin({
        connection_group_members: [{ data: MEMBERSHIP_ROW, error: null }],
        connection_groups: [{ data: null, error: null }],
      })
      const service = makeService(admin)

      await expect(
        service.assertActiveGroupMember('user-1', 'group-1'),
      ).rejects.toMatchObject({ status: 404 })
    })
  })

  describe('requestJoin', () => {
    it('maps INVITE_EXPIRED to 410', async () => {
      const admin = makeAdmin({}, [
        { data: null, error: new Error('INVITE_EXPIRED') },
      ])
      const service = makeService(admin)

      await expect(
        service.requestJoin('user-1', 'ABCD2345'),
      ).rejects.toMatchObject({ status: 410 })
    })

    it('maps ALREADY_MEMBER to 409', async () => {
      const admin = makeAdmin({}, [
        { data: null, error: new Error('ALREADY_MEMBER') },
      ])
      const service = makeService(admin)

      await expect(
        service.requestJoin('user-1', 'ABCD2345'),
      ).rejects.toMatchObject({ status: 409 })
    })
  })

  describe('approveJoinRequest', () => {
    it('passes both caps to the RPC and maps the member', async () => {
      const rpcCalls: RpcCall[] = []
      const admin = makeAdmin(
        {},
        [{ data: MEMBERSHIP_ROW, error: null }],
        rpcCalls,
      )
      const service = makeService(admin)

      const result = await service.approveJoinRequest('decider-1', 'req-1')

      expect(rpcCalls[0].name).toBe('approve_group_join')
      expect(rpcCalls[0].args.p_max_members).toBe(GROUP_MAX_MEMBERS)
      expect(rpcCalls[0].args.p_max_groups).toBe(GROUP_MAX_PER_USER)
      expect(result).toEqual({
        ok: true,
        member: {
          groupId: 'group-1',
          userId: 'user-1',
          joinedAt: '2026-07-14T00:00:00.000Z',
        },
      })
    })

    it('maps MEMBER_LIMIT_EXCEEDED to 422', async () => {
      const admin = makeAdmin({}, [
        { data: null, error: new Error('MEMBER_LIMIT_EXCEEDED') },
      ])
      const service = makeService(admin)

      await expect(
        service.approveJoinRequest('decider-1', 'req-1'),
      ).rejects.toMatchObject({ status: 422 })
    })

    it('maps NOT_GROUP_MEMBER to 403', async () => {
      const admin = makeAdmin({}, [
        { data: null, error: new Error('NOT_GROUP_MEMBER') },
      ])
      const service = makeService(admin)

      await expect(
        service.approveJoinRequest('outsider', 'req-1'),
      ).rejects.toMatchObject({ status: 403 })
    })
  })

  describe('leaveGroup', () => {
    it('returns groupDeleted from the RPC row', async () => {
      const admin = makeAdmin({}, [{ data: [{ group_deleted: true }], error: null }])
      const service = makeService(admin)

      await expect(service.leaveGroup('user-1', 'group-1')).resolves.toEqual({
        ok: true,
        groupDeleted: true,
      })
    })

    it('maps NOT_GROUP_MEMBER to 404 (existence hiding)', async () => {
      const admin = makeAdmin({}, [
        { data: null, error: new Error('NOT_GROUP_MEMBER') },
      ])
      const service = makeService(admin)

      await expect(
        service.leaveGroup('outsider', 'group-1'),
      ).rejects.toMatchObject({ status: 404 })
    })
  })

  describe('createInvite', () => {
    it('issues an 8-char code from the shares alphabet with a 7-day TTL', async () => {
      const queues: Record<string, QueryResult[]> = {
        ...activeMembershipQueues(),
        connection_group_invites: [
          {
            data: { id: 'invite-1', invite_code: 'X', expires_at: 'x' },
            error: null,
          },
        ],
      }
      const admin = makeAdmin(queues)
      const service = makeService(admin)

      const result = await service.createInvite('user-1', 'group-1')

      expect(result.inviteCode).toHaveLength(8)
      for (const char of result.inviteCode) {
        expect(INVITE_CODE_ALPHABET).toContain(char)
      }
      const ttlMs =
        new Date(result.expiresAt).getTime() - Date.now()
      expect(ttlMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
      expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000)
      expect(result.inviteUrl).toContain(`/invite/${result.inviteCode}`)
    })

    it('retries on 23505 code collisions', async () => {
      const conflict = Object.assign(new Error('duplicate key'), {
        code: '23505',
      })
      const queues: Record<string, QueryResult[]> = {
        ...activeMembershipQueues(),
        connection_group_invites: [
          { data: null, error: conflict },
          {
            data: { id: 'invite-1', invite_code: 'X', expires_at: 'x' },
            error: null,
          },
        ],
      }
      const admin = makeAdmin(queues)
      const service = makeService(admin)

      const result = await service.createInvite('user-1', 'group-1')
      expect(result.inviteId).toBe('invite-1')
    })
  })

  describe('revokeInvite', () => {
    it('404s when no live invite row matches', async () => {
      const queues: Record<string, QueryResult[]> = {
        ...activeMembershipQueues(),
        connection_group_invites: [{ data: [], error: null }],
      }
      const admin = makeAdmin(queues)
      const service = makeService(admin)

      await expect(
        service.revokeInvite('user-1', 'group-1', 'invite-x'),
      ).rejects.toMatchObject({ status: 404 })
    })
  })

  describe('listGroups', () => {
    it('aggregates member counts per group', async () => {
      const admin = makeAdmin({
        connection_group_members: [
          { data: [{ group_id: 'group-1' }], error: null },
          {
            data: [{ group_id: 'group-1' }, { group_id: 'group-1' }],
            error: null,
          },
        ],
        connection_groups: [{ data: [GROUP_ROW], error: null }],
      })
      const service = makeService(admin)

      const result = await service.listGroups('user-1')
      expect(result.groups).toHaveLength(1)
      expect(result.groups[0].memberCount).toBe(2)
    })

    it('returns an empty list without touching groups when no memberships', async () => {
      const admin = makeAdmin({
        connection_group_members: [{ data: [], error: null }],
      })
      const service = makeService(admin)

      await expect(service.listGroups('user-1')).resolves.toEqual({
        groups: [],
      })
    })
  })
})

describe('joinRequestSchema', () => {
  it('normalizes invite codes to upper case', () => {
    expect(joinRequestSchema.parse({ inviteCode: 'abcd2345' })).toEqual({
      inviteCode: 'ABCD2345',
    })
  })

  it('rejects codes with the wrong length', () => {
    expect(joinRequestSchema.safeParse({ inviteCode: 'ABC' }).success).toBe(
      false,
    )
  })
})
