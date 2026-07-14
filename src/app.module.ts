import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { AuthModule } from '@/auth/auth.module'
import { BadgesModule } from '@/badges/badges.module'
import { BoardsModule } from '@/boards/boards.module'
import { ConnectionsModule } from '@/connections/connections.module'
import { validateEnv } from '@/config/env'
import { GroupBoardsModule } from '@/group-boards/group-boards.module'
import { HealthModule } from '@/health/health.module'
import { JobsModule } from '@/jobs/jobs.module'
import { MediaModule } from '@/media/media.module'
import { MissionsModule } from '@/missions/missions.module'
import { QaAuthModule } from '@/qa-auth/qa-auth.module'
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
    ConnectionsModule,
    GroupBoardsModule,
    BadgesModule,
    MissionsModule,
    MediaModule,
    SharesModule,
    QaAuthModule,
    JobsModule,
  ],
})
export class AppModule {}
