import type { OsArch } from "../interfaces/provider.interface"

export function normalizeOs(
  s: string
): "linux" | "darwin" | "freebsd" | "windows" | "unknown" {
  const v = s.toLowerCase()
  if (v.startsWith("linux")) return "linux"
  if (v.startsWith("darwin") || v.startsWith("mac")) return "darwin"
  if (v.startsWith("freebsd")) return "freebsd"
  if (v.startsWith("win") || v.includes("windows")) return "windows"
  if (v === "win32") return "windows"
  return "unknown"
}

export function normalizeArch(a: string): OsArch {
  const v = a.toLowerCase().trim()

  // common aliases
  if (["x64", "x86_64", "amd64"].includes(v)) return "x86_64"
  if (["aarch64", "arm64"].includes(v)) return "arm64"
  if (["armv7l", "armv7", "armhf"].includes(v)) return "armv7"
  if (["armv6l", "armv6"].includes(v)) return "armv6"
  if (["i386", "i686", "ia32"].includes(v)) return "i386"
  if (["ppc64le"].includes(v)) return "ppc64le"
  if (["s390x"].includes(v)) return "s390x"
  if (["riscv64"].includes(v)) return "riscv64"
  if (["loongarch64"].includes(v)) return "loongarch64"

  // fallback to raw
  return a as any
}
