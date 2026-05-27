interface SupabaseLikeError {
  code?: string
  message?: string
  details?: string
  hint?: string
}

function errorText(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const record = error as SupabaseLikeError
  return [record.message, record.details, record.hint].filter(Boolean).join(' ')
}

export function isMissingColumnError(
  error: unknown,
  columns: readonly string[],
) {
  if (!error || typeof error !== 'object') return false

  const record = error as SupabaseLikeError
  if (record.code === '42703') return true

  const text = errorText(error)
  return columns.some((column) => text.includes(column))
}
