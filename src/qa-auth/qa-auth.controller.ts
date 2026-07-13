import { Body, Controller, Post } from '@nestjs/common'

import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe'
import {
  qaAuthSessionSchema,
  type QaAuthSessionInput,
} from '@/qa-auth/qa-auth.schemas'
import { QaAuthService } from '@/qa-auth/qa-auth.service'

@Controller('qa/auth')
export class QaAuthController {
  constructor(private readonly qaAuthService: QaAuthService) {}

  @Post('session')
  createSession(
    @Body(new ZodValidationPipe(qaAuthSessionSchema))
    input: QaAuthSessionInput,
  ) {
    return this.qaAuthService.createSession(input)
  }
}
