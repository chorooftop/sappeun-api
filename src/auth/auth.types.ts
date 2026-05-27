import type { Request } from 'express'
import type { User } from '@supabase/supabase-js'

export type CurrentUserSource = 'bearer' | 'none'
export type GuestSessionSource = 'header' | 'none'

export interface AuthenticatedRequest extends Request {
  user?: User
}

export interface CurrentUserLookup {
  user: User | null
  source: CurrentUserSource
}

export interface GuestSessionLookup {
  guestSessionId: string | null
  source: GuestSessionSource
}
