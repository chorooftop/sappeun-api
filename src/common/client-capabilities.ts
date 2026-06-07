export interface ClientCapabilities {
  appBuild: number | null
  capabilities: ReadonlySet<string>
}

export interface CapabilityGatedRow {
  min_app_build?: number | null
  required_capabilities?: readonly string[] | null
  active_from?: string | null
  active_until?: string | null
}

export const LEGACY_CLIENT_CAPABILITIES: ClientCapabilities = {
  appBuild: null,
  capabilities: new Set<string>(),
}

const APP_BUILD_HEADER = 'x-sappeun-app-build'
const CLIENT_CAPABILITIES_HEADER = 'x-sappeun-client-capabilities'
const CAPABILITY_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const MAX_CAPABILITY_TOKENS = 50

function headerValue(
  headers: Record<string, unknown>,
  name: string,
): string | undefined | null {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )
  if (!entry) return undefined

  const value = entry[1]
  if (Array.isArray(value)) {
    if (value.length !== 1) return null
    return typeof value[0] === 'string' ? value[0] : null
  }

  return typeof value === 'string' ? value : null
}

function legacyClient(): ClientCapabilities {
  return LEGACY_CLIENT_CAPABILITIES
}

export function parseClientCapabilities(
  headers: Record<string, unknown>,
): ClientCapabilities {
  const rawBuild = headerValue(headers, APP_BUILD_HEADER)
  const rawCapabilities = headerValue(headers, CLIENT_CAPABILITIES_HEADER)

  if (rawBuild === null || rawCapabilities === null) return legacyClient()
  if (rawBuild === undefined && rawCapabilities === undefined) {
    return legacyClient()
  }
  if (rawBuild === undefined || rawCapabilities === undefined) {
    return legacyClient()
  }
  if (rawBuild.trim() === '' || rawCapabilities.trim() === '') {
    return legacyClient()
  }

  let appBuild: number | null = null
  if (!/^\d+$/.test(rawBuild.trim())) return legacyClient()
  const parsed = Number(rawBuild.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return legacyClient()
  appBuild = parsed

  const capabilities = new Set<string>()
  const tokens = rawCapabilities
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0 || tokens.length > MAX_CAPABILITY_TOKENS) {
    return legacyClient()
  }

  for (const token of tokens) {
    if (!CAPABILITY_TOKEN_RE.test(token)) return legacyClient()
    capabilities.add(token)
  }

  return { appBuild, capabilities }
}

function parseTime(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function isVisibleToClient(
  row: CapabilityGatedRow,
  client: ClientCapabilities,
  now: Date = new Date(),
) {
  const nowMs = now.getTime()

  if (row.active_from) {
    const activeFrom = parseTime(row.active_from)
    if (activeFrom === null || activeFrom > nowMs) return false
  }

  if (row.active_until) {
    const activeUntil = parseTime(row.active_until)
    if (activeUntil === null || nowMs >= activeUntil) return false
  }

  if (row.min_app_build != null) {
    if (client.appBuild == null || client.appBuild < row.min_app_build) {
      return false
    }
  }

  for (const capability of row.required_capabilities ?? []) {
    if (!client.capabilities.has(capability)) return false
  }

  return true
}
