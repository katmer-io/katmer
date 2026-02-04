export function targetDir(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(0, idx) || "/" : "."
}

export function baseName(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(idx + 1) : p
}
