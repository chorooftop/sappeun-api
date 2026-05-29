// Phase 0 스키마 진단 스크립트
// PostgREST OpenAPI(루트) + 행 프로브로 public 스키마의 실제 컬럼/타입을 확정한다.
// DB 비밀번호 없이 service-role 키만으로 동작한다.
// 한계: RLS 정책, FK on-delete 동작, CHECK 제약, 기본값은 OpenAPI로 완전 노출되지 않는다.
//       (완전한 baseline은 supabase db dump = DB 비밀번호 필요)
//
// 실행: node --env-file=.env scripts/introspect-schema.mjs
//   또는 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수 주입 후 실행.

import { readFileSync } from 'node:fs'

function loadEnvFallback() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch {
    /* ignore */
  }
}

loadEnvFallback()

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락')
  process.exit(1)
}

const headers = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
}

const ACCOUNT_TABLES = ['profiles', 'user_consents', 'account_deletions']
const PROFILE_COLS_OF_INTEREST = [
  'user_id',
  'nickname',
  'nickname_updated_at',
  'display_name',
  'avatar_url',
  'primary_provider',
  'first_login_at',
  'last_seen_at',
  'signup_completed_at',
  'onboarding_completed_at',
  'birth_date',
  'deleted_at',
  'deletion_reason',
  'purge_scheduled_at',
]

async function fetchOpenApi() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers })
  if (!res.ok) throw new Error(`OpenAPI ${res.status} ${await res.text()}`)
  return res.json()
}

async function probeRow(table) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`,
    { headers },
  )
  if (!res.ok) return { exists: false, status: res.status }
  const rows = await res.json()
  return { exists: true, columns: rows[0] ? Object.keys(rows[0]) : null }
}

function columnsFromDefinition(def) {
  if (!def?.properties) return []
  return Object.entries(def.properties).map(([name, p]) => {
    const fk = /<fk table='([^']+)' column='([^']+)'>/.exec(p.description || '')
    return {
      name,
      type: p.format || p.type || '?',
      pk: /<pk\/>/.test(p.description || ''),
      fk: fk ? `${fk[1]}.${fk[2]}` : null,
    }
  })
}

const openapi = await fetchOpenApi()
const defs = openapi.definitions || {}
const allTables = Object.keys(defs).sort()

console.log('='.repeat(70))
console.log('PUBLIC 스키마 노출 테이블/뷰:', allTables.join(', '))
console.log('='.repeat(70))

for (const table of ACCOUNT_TABLES) {
  console.log(`\n### ${table}`)
  if (!defs[table]) {
    const probe = await probeRow(table)
    console.log(
      probe.exists
        ? `  (OpenAPI 미노출이나 접근 가능. columns=${probe.columns ?? '행 없음'})`
        : `  ❌ 없음 (probe status ${probe.status})`,
    )
    continue
  }
  const cols = columnsFromDefinition(defs[table])
  for (const c of cols) {
    console.log(
      `  - ${c.name}: ${c.type}${c.pk ? ' [PK]' : ''}${c.fk ? ` [FK→${c.fk}]` : ''}`,
    )
  }
  if (table === 'profiles') {
    console.log('  -- 관심 컬럼 존재 여부 --')
    const present = new Set(cols.map((c) => c.name))
    for (const col of PROFILE_COLS_OF_INTEREST) {
      console.log(`    ${present.has(col) ? '✅' : '❌'} ${col}`)
    }
  }
}

// 뷰 존재 확인
console.log('\n### user_identities_v (뷰)')
console.log(defs['user_identities_v'] ? '  ✅ 존재' : '  ❌ 없음')

console.log('\n[완료] OpenAPI 기반 진단. RLS/FK cascade/CHECK/기본값은 db dump 필요.')
