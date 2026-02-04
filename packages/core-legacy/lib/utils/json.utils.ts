export function safeJsonParse(input: any) {
  try {
    return JSON.parse(input)
  } catch {
    return input?.toString()
  }
}

export function wrapInArray<T>(input?: T | T[] | null): T[] {
  return (
    Array.isArray(input) ? input
    : input != null ? [input]
    : []
  )
}
