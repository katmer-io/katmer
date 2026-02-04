export function nowIso(): string {
  return new Date().toISOString()
}
export function msToDelta(ms: number): string {
  // format: H:MM:SS.mmm  (e.g., "0:00:00.123")
  const sign = ms < 0 ? "-" : ""
  ms = Math.abs(ms)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const msRest = ms % 1000
  const pad2 = (n: number) => n.toString().padStart(2, "0")
  const pad3 = (n: number) => n.toString().padStart(3, "0")
  return `${sign}${h}:${pad2(m)}:${pad2(s)}.${pad3(msRest)}`
}
