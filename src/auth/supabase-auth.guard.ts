import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'

import type { AuthenticatedRequest } from '@/auth/auth.types'
import { AuthService } from '@/auth/auth.service'

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    request.user = await this.authService.requireUser(request)
    return true
  }
}
