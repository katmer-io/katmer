export function toOctal<T extends number | string | null | undefined>(
  mode: T
): T extends null | undefined ? undefined : string {
  if (mode === null || mode === undefined) return undefined as any
  if (typeof mode === "number") {
    return ("0" + mode.toString(8)) as any
  }
  return String(mode).replace(/^0?([0-7]{3,4})$/, "0$1") as any
}
