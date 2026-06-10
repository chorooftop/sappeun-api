import { describe, expect, it } from 'vitest'

import {
  clipPreviewSchema,
  confirmClipUploadSchema,
  confirmPhotoUploadSchema,
  photoPreviewSchema,
  presignClipUploadSchema,
  presignPhotoUploadSchema,
  updateClipDescriptionSchema,
} from '@/media/media.schemas'

function cells(count: number) {
  return Array.from({ length: count }, (_, index) => `cell-${index}`)
}

function missionSnapshots(cellIds: readonly string[]) {
  return cellIds.map((id) => ({
    id,
    category: 'nature' as const,
    label: `Mission ${id}`,
    icon: null,
    variant: 'QeQCU' as const,
  }))
}

function validClipPresign() {
  const cellIds = cells(9)

  return {
    clientBoardSessionId: 'session-1',
    mode: '3x3' as const,
    boardKind: 'mission' as const,
    nickname: 'tester',
    title: 'Morning walk',
    freePosition: 4,
    cellIds,
    missionSnapshots: missionSnapshots(cellIds),
    position: 1,
    cellId: 'cell-1',
    contentType: 'video/mp4' as const,
    recorderMimeType: 'video/mp4; codecs=avc1',
    sizeBytes: 1024,
    durationMs: 1200,
    posterContentType: 'image/jpeg' as const,
    posterSizeBytes: 512,
  }
}

describe('presignPhotoUploadSchema', () => {
  it('rejects mismatched position and cell id', () => {
    const parsed = presignPhotoUploadSchema.safeParse({
      clientBoardSessionId: 'session-1',
      mode: '3x3',
      nickname: 'tester',
      freePosition: 4,
      cellIds: cells(9),
      position: 1,
      cellId: 'cell-2',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    })

    expect(parsed.success).toBe(false)
  })
})

describe('presignClipUploadSchema', () => {
  it('requires a complete board snapshot', () => {
    const { boardKind, title, missionSnapshots: snapshots, ...input } =
      validClipPresign()

    expect(boardKind).toBe('mission')
    expect(title).toBe('Morning walk')
    expect(snapshots).toHaveLength(9)
    expect(presignClipUploadSchema.safeParse(input).success).toBe(false)
  })

  it('accepts a valid complete clip upload request', () => {
    expect(presignClipUploadSchema.safeParse(validClipPresign()).success).toBe(
      true,
    )
  })
})

describe('updateClipDescriptionSchema', () => {
  it('rejects board snapshots with mismatched mission ids', () => {
    const cellIds = cells(9)
    const parsed = updateClipDescriptionSchema.safeParse({
      ownerKind: 'user',
      description: 'Updated',
      boardSnapshot: {
        boardKind: 'mission',
        title: 'Morning walk',
        freePosition: 4,
        cellIds,
        missionSnapshots: [
          { ...missionSnapshots(cellIds)[0], id: 'wrong-cell' },
          ...missionSnapshots(cellIds).slice(1),
        ],
      },
    })

    expect(parsed.success).toBe(false)
  })
})

describe('media ownerKind schemas', () => {
  it('rejects guest-owned media operations', () => {
    const photoId = '00000000-0000-4000-8000-000000000001'
    const clipId = '00000000-0000-4000-8000-000000000002'

    expect(
      confirmPhotoUploadSchema.safeParse({
        photoId,
        ownerKind: 'guest',
      }).success,
    ).toBe(false)
    expect(
      photoPreviewSchema.safeParse({
        photos: [{ photoId, ownerKind: 'guest' }],
      }).success,
    ).toBe(false)
    expect(
      confirmClipUploadSchema.safeParse({
        clipId,
        ownerKind: 'guest',
      }).success,
    ).toBe(false)
    expect(
      clipPreviewSchema.safeParse({
        clips: [{ clipId, ownerKind: 'guest' }],
      }).success,
    ).toBe(false)
    expect(
      updateClipDescriptionSchema.safeParse({
        ownerKind: 'guest',
        description: 'Updated',
      }).success,
    ).toBe(false)
  })
})
