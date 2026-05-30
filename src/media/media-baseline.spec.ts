import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const baselineSql = readFileSync(
  join(process.cwd(), 'supabase/migrations/0001_remote_baseline.sql'),
  'utf8',
)

describe('media baseline SQL', () => {
  it('keeps upload confirm RPCs service-role only', () => {
    expect(baselineSql).toContain("coalesce(auth.role(), '') <> 'service_role'")
    expect(baselineSql).toContain(
      'REVOKE ALL ON FUNCTION public.confirm_user_photo_upload',
    )
    expect(baselineSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.confirm_user_photo_upload',
    )
    expect(baselineSql).toContain(
      'REVOKE ALL ON FUNCTION public.confirm_user_clip_upload',
    )
    expect(baselineSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.confirm_user_clip_upload',
    )
  })
})
