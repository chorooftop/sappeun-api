import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac } from 'node:crypto'

import type { AppEnv } from '@/config/env'

interface R2KeyInput {
  id: string
  ext: string
  position: number
}

interface R2UserKeyInput extends R2KeyInput {
  userId: string
  boardId: string
}

interface R2GuestKeyInput extends R2KeyInput {
  guestSessionId: string
  clientBoardSessionId: string
}

export interface R2SignedUpload {
  bucketName: string
  objectKey: string
  signedUrl: string
  uploadHeaders: Record<string, string>
}

export interface R2ObjectMetadata {
  etag: string | null
  contentType: string | null
  sizeBytes: number | null
}

export function createR2OwnerHash(
  secret: string,
  kind: 'guest' | 'user',
  id: string,
) {
  return createHmac('sha256', secret)
    .update(`${kind}:${id}`)
    .digest('hex')
    .slice(0, 32)
}

function encodeCopySource(bucketName: string, objectKey: string) {
  return `${bucketName}/${objectKey
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`
}

@Injectable()
export class R2Service {
  private readonly client: S3Client

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    const accountId = this.config.get('R2_ACCOUNT_ID', { infer: true })
    const endpoint =
      this.config.get('R2_ENDPOINT', { infer: true }) ??
      `https://${accountId}.r2.cloudflarestorage.com`

    this.client = new S3Client({
      region: this.config.get('R2_REGION', { infer: true }),
      endpoint,
      credentials: {
        accessKeyId: this.config.get('R2_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: this.config.get('R2_SECRET_ACCESS_KEY', {
          infer: true,
        }),
      },
    })
  }

  get bucketName() {
    return this.config.get('R2_BUCKET', { infer: true })
  }

  ownerHash(kind: 'guest' | 'user', id: string) {
    return createR2OwnerHash(
      this.config.get('R2_OWNER_HASH_SECRET', { infer: true }),
      kind,
      id,
    )
  }

  userPrefix(userId: string) {
    return `users/${this.ownerHash('user', userId)}/`
  }

  guestPrefix(guestSessionId: string) {
    return `temp/${this.ownerHash('guest', guestSessionId)}/`
  }

  userPhotoKey(input: R2UserKeyInput) {
    return `${this.userPrefix(input.userId)}boards/${input.boardId}/cells/${
      input.position
    }/photos/${input.id}.${input.ext}`
  }

  guestPhotoKey(input: R2GuestKeyInput) {
    return `${this.guestPrefix(input.guestSessionId)}boards/${
      input.clientBoardSessionId
    }/cells/${input.position}/photos/${input.id}.${input.ext}`
  }

  userClipKey(input: R2UserKeyInput) {
    return `${this.userPrefix(input.userId)}boards/${input.boardId}/cells/${
      input.position
    }/clips/${input.id}.${input.ext}`
  }

  userPosterKey(input: R2UserKeyInput) {
    return `${this.userPrefix(input.userId)}boards/${input.boardId}/cells/${
      input.position
    }/posters/${input.id}.${input.ext}`
  }

  guestClipKey(input: R2GuestKeyInput) {
    return `${this.guestPrefix(input.guestSessionId)}boards/${
      input.clientBoardSessionId
    }/cells/${input.position}/clips/${input.id}.${input.ext}`
  }

  guestPosterKey(input: R2GuestKeyInput) {
    return `${this.guestPrefix(input.guestSessionId)}boards/${
      input.clientBoardSessionId
    }/cells/${input.position}/posters/${input.id}.${input.ext}`
  }

  async createSignedUpload(params: {
    objectKey: string
    contentType: string
    expiresInSeconds: number
  }): Promise<R2SignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: params.objectKey,
      ContentType: params.contentType,
    })
    const signedUrl = await getSignedUrl(this.client, command, {
      expiresIn: params.expiresInSeconds,
      signableHeaders: new Set(['content-type']),
    })

    return {
      bucketName: this.bucketName,
      objectKey: params.objectKey,
      signedUrl,
      uploadHeaders: {
        'content-type': params.contentType,
      },
    }
  }

  async createPreviewUrl(params: {
    objectKey: string
    expiresInSeconds: number
    bucketName?: string | null
  }) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: params.bucketName ?? this.bucketName,
        Key: params.objectKey,
      }),
      { expiresIn: params.expiresInSeconds },
    )
  }

  async headObject(params: {
    objectKey: string
    bucketName?: string | null
  }): Promise<R2ObjectMetadata> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: params.bucketName ?? this.bucketName,
        Key: params.objectKey,
      }),
    )

    return {
      etag: response.ETag?.replace(/^"|"$/g, '') ?? null,
      contentType: response.ContentType ?? null,
      sizeBytes: response.ContentLength ?? null,
    }
  }

  async assertObjectMatches(
    params: {
      objectKey: string
      bucketName?: string | null
    },
    expected: { contentType: string; sizeBytes: number },
  ) {
    const metadata = await this.headObject(params)
    const actualType = metadata.contentType?.split(';', 1)[0]?.toLowerCase()
    const expectedType = expected.contentType.split(';', 1)[0]?.toLowerCase()

    if (
      metadata.sizeBytes !== null &&
      metadata.sizeBytes !== expected.sizeBytes
    ) {
      throw new Error('Uploaded object size does not match the signed request.')
    }

    if (actualType && actualType !== expectedType) {
      throw new Error(
        'Uploaded object content type does not match the signed request.',
      )
    }

    return metadata
  }

  async copyObject(params: {
    sourceKey: string
    destinationKey: string
    bucketName?: string | null
    contentType?: string
  }) {
    const bucketName = params.bucketName ?? this.bucketName
    await this.client.send(
      new CopyObjectCommand({
        Bucket: bucketName,
        Key: params.destinationKey,
        CopySource: encodeCopySource(bucketName, params.sourceKey),
        ContentType: params.contentType,
        MetadataDirective: params.contentType ? 'REPLACE' : undefined,
      }),
    )
  }

  async deleteObjects(
    objectKeys: readonly string[],
    bucketName?: string | null,
  ) {
    const bucket = bucketName ?? this.bucketName
    await Promise.all(
      objectKeys.map((objectKey) =>
        this.client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: objectKey,
          }),
        ),
      ),
    )
  }

  async deletePrefix(prefix: string, bucketName?: string | null) {
    const bucket = bucketName ?? this.bucketName
    let continuationToken: string | undefined
    let deleted = 0

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )
      const objectKeys =
        listed.Contents?.map((object) => object.Key).filter(
          (key): key is string => Boolean(key),
        ) ?? []

      if (objectKeys.length) {
        await this.deleteObjects(objectKeys, bucket)
        deleted += objectKeys.length
      }

      continuationToken = listed.NextContinuationToken
    } while (continuationToken)

    return { deleted }
  }
}
