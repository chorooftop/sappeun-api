import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { AuthModule } from '@/auth/auth.module'
import { BoardsModule } from '@/boards/boards.module'
import { validateEnv } from '@/config/env'
import { HealthModule } from '@/health/health.module'
import { JobsModule } from '@/jobs/jobs.module'
import { MediaModule } from '@/media/media.module'
import { SharesModule } from '@/shares/shares.module'
import { StorageModule } from '@/storage/storage.module'
import { SupabaseModule } from '@/supabase/supabase.module'
import { UsersModule } from '@/users/users.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    SupabaseModule,
    AuthModule,
    StorageModule,
    HealthModule,
    UsersModule,
    BoardsModule,
    MediaModule,
    SharesModule,
    JobsModule,
  ],
})
export class AppModule {}
