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

    throw new BadRequestException({
      error: 'Invalid request body.',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
}
