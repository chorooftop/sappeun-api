import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'

import type { AppEnv } from '@/config/env'

@Injectable()
export class SupabaseService {
  readonly anonClient: any
  readonly adminClient: any

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    const url = this.config.get('SUPABASE_URL', { infer: true })
    const anonKey = this.config.get('SUPABASE_ANON_KEY', { infer: true })
    const serviceRoleKey = this.config.get('SUPABASE_SERVICE_ROLE_KEY', {
      infer: true,
    })

    const authOptions = {
      persistSession: false,
      autoRefreshToken: false,
    }
    const clientOptions = {
      auth: authOptions,
      realtime: {
        transport: WebSocket as any,
      },
    }

    this.anonClient = createClient(url, anonKey, clientOptions)
    this.adminClient = createClient(url, serviceRoleKey, clientOptions)
  }
}
