import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common'
import type { ZodType } from 'zod'

@Injectable()
export class ZodValidationPipe<
  TInput = unknown,
  TOutput = unknown,
> implements PipeTransform<TInput, TOutput> {
  constructor(private readonly schema: ZodType<TOutput, TInput>) {}

  transform(value: TInput): TOutput {
    const parsed = this.schema.safeParse(value)
    if (parsed.success) return parsed.data

    const rawMode =
      value && typeof value === 'object'
        ? (value as { mode?: unknown }).mode
        : undefined
    const isUnsupportedBoardMode =
      rawMode != null &&
      rawMode !== '3x3' &&
      parsed.error.issues.some(
        (issue) =>
          issue.path.join('.') === 'mode' &&
          (issue.code === 'invalid_value' || issue.code === 'invalid_type'),
      )

    if (isUnsupportedBoardMode) {
      throw new BadRequestException({
        code: 'BOARD_MODE_UNSUPPORTED',
        message: 'Only 3x3 boards are supported.',
      })
    }

    throw new BadRequestException({
      error: 'Invalid request body.',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
}
