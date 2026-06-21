import { randomUUID } from 'node:crypto'

type LogLevel = 'info' | 'warn' | 'error' | 'fatal'

interface SerializedError {
  name: string
  message: string
  stack?: string
}

type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializedError

type LogFields = Record<string, LogValue>

const ERROR_LEVELS = new Set<LogLevel>(['warn', 'error', 'fatal'])

export function createRequestId() {
  return randomUUID().slice(0, 12)
}

export function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: 'UnknownError',
    message: String(error),
  }
}

export function writeStructuredLog(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  }
  const line = JSON.stringify(payload)

  if (ERROR_LEVELS.has(level)) {
    console.error(line)
    return
  }

  console.info(line)
}
