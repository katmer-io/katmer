import type {
  KatmerProvider,
  OsArch,
  OsFamily,
  OsInfo
} from "./interfaces/provider.interface"
import type { Katmer } from "./interfaces/task.interface"
import type {
  ModuleCommonReturn,
  ModuleConstraints,
  ModuleOptions,
  ModulePlatformConstraint,
  PackageConstraint,
  BinaryConstraint,
  PackageManager
} from "./interfaces/module.interface"
import { wrapInArray } from "./utils/json.utils"
import semver from "semver"

export abstract class KatmerModule<
  TOptions extends ModuleOptions = ModuleOptions,
  TReturn extends { [key: string]: any } = {},
  TProvider extends KatmerProvider = KatmerProvider
> {
  static readonly name: string
  abstract constraints: ModuleConstraints

  constructor(
    public params: TOptions,
    public provider: TProvider
  ) {}

  private async checkConstraints(ctx: Katmer.TaskContext<TProvider>) {
    const osInfo = ctx.provider.os
    const family = (osInfo?.family || "unknown") as OsFamily
    const arch = (osInfo?.arch || "unknown") as OsArch
    const distro = normalizeDistroId(osInfo) // e.g. "ubuntu", "rhel", "alpine", ...

    const platformMap = this.constraints.platform || {}

    // Resolve base: specific family OR "any" OR "local
    const base =
      (ctx.provider.type === "local" &&
        normalizeConstraint(platformMap.local)) ??
      normalizeConstraint(platformMap[family]) ??
      normalizeConstraint(platformMap.any)

    if (!base) {
      throw new Error(
        `Module '${this.constructor.name}' does not support platform '${family}'`
      )
    }

    // Merge distro overrides (any + specific)
    const merged = mergeConstraints(
      base,
      normalizeConstraint(base.distro?.any),
      normalizeConstraint(base.distro?.[distro])
    )

    // ARCH check
    const archList = merged.arch?.length ? merged.arch : ["any"]
    if (!archList.includes("any") && !archList.includes(arch)) {
      throw new Error(
        `Module '${this.constructor.name}' does not support architecture '${arch}' on '${family}'`
      )
    }

    // root/admin requirement
    if (merged.requireRoot) {
      const isRoot = await checkRoot(ctx, family)
      if (!isRoot) {
        throw new Error(
          `Module '${this.constructor.name}' requires elevated privileges (root/Administrator) on '${family}'.`
        )
      }
    }

    // kernel/OS version gates
    if (merged.minKernel && family !== "windows") {
      const kv = await getKernelVersion(ctx, family)
      if (kv && !(await satisfiesVersion(kv, merged.minKernel))) {
        throw new Error(
          `Kernel version ${kv} does not satisfy required '${merged.minKernel}' for '${this.constructor.name}'.`
        )
      }
    }
    if (merged.minOsVersion) {
      const ov = osInfo?.versionId
      if (ov && !(await satisfiesVersion(ov, merged.minOsVersion))) {
        throw new Error(
          `OS version ${ov} does not satisfy required '${merged.minOsVersion}' for '${this.constructor.name}'.`
        )
      }
    }

    // binaries check
    if (merged.binaries?.length) {
      for (const b of merged.binaries) {
        const ok = await checkBinary(ctx, family, b)
        if (!ok) {
          throw new Error(
            `Required binary '${b.cmd}'${b.range ? ` (version ${b.range})` : ""} not satisfied for '${this.constructor.name}'.`
          )
        }
      }
    }

    // packages check (presence + optional version)
    const pkgList = normalizePackageList(merged.packages)
    if (pkgList.length) {
      const pm = await detectPackageManager(ctx, family)
      for (const p of pkgList) {
        const ok = await checkPackage(ctx, family, pm, p)
        if (!ok) {
          const name =
            p.name ||
            p.alternatives?.map((a) => a.name).join(" | ") ||
            "<unknown>"
          throw new Error(
            `Required package '${name}'${
              p.range ? ` (${p.range})`
              : p.version ? ` (= ${p.version})`
              : ""
            } not satisfied on '${family}'${pm ? ` (manager: ${pm})` : ""}.`
          )
        }
      }
    }
  }

  async doCheck(ctx: Katmer.TaskContext<TProvider>) {
    await this.checkConstraints(ctx)
    await this.check(ctx)
  }

  async doInitialize(ctx: Katmer.TaskContext<TProvider>) {
    await this.initialize(ctx)
  }

  async doExecute(
    ctx: Katmer.TaskContext<TProvider>
  ): Promise<ModuleCommonReturn & TReturn> {
    return await this.execute(ctx)
  }

  async doCleanup(ctx: Katmer.TaskContext<TProvider>) {
    await this.cleanup(ctx)
  }

  protected abstract check(ctx: Katmer.TaskContext<TProvider>): Promise<void>
  protected abstract initialize(
    ctx: Katmer.TaskContext<TProvider>
  ): Promise<void>
  protected abstract execute(
    ctx: Katmer.TaskContext<TProvider>
  ): Promise<ModuleCommonReturn & TReturn>
  protected abstract cleanup(ctx: Katmer.TaskContext<TProvider>): Promise<void>
}

/* ------------------------ helpers ------------------------ */

// Combine family/distro layers (later overrides earlier). Null/false disables.
function mergeConstraints(
  ...layers: (ModulePlatformConstraint | null | undefined)[]
): ModulePlatformConstraint {
  const out: ModulePlatformConstraint = {}
  for (const l of layers) {
    if (!l) continue
    // simple shallow merge for defined keys
    if (l.arch) out.arch = Array.isArray(l.arch) ? l.arch.slice() : [l.arch]
    if (l.packages) out.packages = l.packages.slice()
    if (l.binaries) out.binaries = l.binaries.slice()
    if (typeof l.requireRoot === "boolean") out.requireRoot = l.requireRoot
    if (l.minKernel) out.minKernel = l.minKernel
    if (l.minOsVersion) out.minOsVersion = l.minOsVersion
    if (l.distro) out.distro = { ...(out.distro || {}), ...l.distro }
  }
  return out
}

// Normalize a platform entry: true → {}, false/undefined → null
function normalizeConstraint(
  c: true | false | ModulePlatformConstraint | undefined
): ModulePlatformConstraint | null {
  if (c === true) return {}
  if (!c) return null
  return c
}

function normalizeDistroId(osInfo?: OsInfo | any): string {
  const raw = (
    osInfo?.distroId ||
    osInfo?.distro ||
    osInfo?.id ||
    osInfo?.name ||
    ""
  )
    .toString()
    .toLowerCase()
  if (!raw) return "any"
  // very light normalization
  if (/ubuntu/.test(raw)) return "ubuntu"
  if (/debian/.test(raw)) return "debian"
  if (/rhel|red hat|redhat/.test(raw)) return "rhel"
  if (/centos/.test(raw)) return "centos"
  if (/rocky/.test(raw)) return "rocky"
  if (/fedora/.test(raw)) return "fedora"
  if (/alpine/.test(raw)) return "alpine"
  if (/arch/.test(raw)) return "arch"
  if (/sles|suse|opensuse/.test(raw)) return "opensuse"
  if (/amzn|amazon linux/.test(raw)) return "amazon"
  return raw
}

async function checkRoot(
  ctx: Katmer.TaskContext<any>,
  family: OsFamily | "unknown"
) {
  if (family === "windows") {
    const ps = `powershell -NoProfile -NonInteractive -Command "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | Write-Output"`
    const r = await ctx.exec(ps)
    return r.code === 0 && /True/i.test(r.stdout || "")
  } else {
    const r = await ctx.exec(`id -u`)
    return r.code === 0 && String(r.stdout || "").trim() === "0"
  }
}

async function getKernelVersion(
  ctx: Katmer.TaskContext<any>,
  family: OsFamily | "unknown"
) {
  if (family === "windows") return null
  const r = await ctx.exec(`uname -r`)
  if (r.code !== 0) return null
  return String(r.stdout || "").trim()
}

async function checkBinary(
  ctx: Katmer.TaskContext<any>,
  family: OsFamily | "unknown",
  b: BinaryConstraint
): Promise<boolean> {
  // OR group support
  if (b.or && b.or.length) {
    for (const alt of b.or) {
      if (await checkBinary(ctx, family, alt)) return true
    }
    return false
  }

  // locate
  let found = false
  if (family === "windows") {
    const r = await ctx.exec(
      `powershell -NoProfile -NonInteractive -Command "Get-Command ${b.cmd} -ErrorAction SilentlyContinue | Select-Object -First 1"`
    )
    found = r.code === 0 && /\S/.test(r.stdout || "")
  } else {
    const r = await ctx.exec(
      `sh -lc 'command -v ${shq(b.cmd)} >/dev/null 2>&1'`
    )
    found = r.code === 0
  }
  if (!found) return false

  // version constraint (optional)
  if (b.range || b.versionRegex) {
    const args = b.args?.length ? b.args.join(" ") : "--version"
    const r = await ctx.exec(`${b.cmd} ${args}`)
    const out = (r.stdout || r.stderr || "").trim()
    const ver =
      b.versionRegex ?
        (out.match(new RegExp(b.versionRegex))?.[1] || "").trim()
      : coerceVersion(out)
    if (!ver) return !b.range // if we couldn't parse, accept only when no range is requested
    if (b.range && !(await satisfiesVersion(ver, b.range))) return false
  }
  return true
}

async function checkPackage(
  ctx: Katmer.TaskContext<any>,
  family: OsFamily | "unknown",
  pm: PackageManager,
  p: PackageConstraint
): Promise<boolean> {
  // Alternatives (any-of)
  if (p.alternatives?.length) {
    for (const alt of p.alternatives) {
      if (await checkPackage(ctx, family, pm, alt)) return true
    }
    return false
  }

  // Custom test command shortcut
  if (p.testCmd) {
    const r = await ctx.exec(p.testCmd)
    if (r.code !== 0) return false
    const raw = (r.stdout || r.stderr || "").trim()
    const ver =
      p.versionRegex ?
        (raw.match(new RegExp(p.versionRegex))?.[1] || "").trim()
      : coerceVersion(raw)
    if (p.version && ver) return verEquals(ver, p.version)
    if (p.range && ver) return await satisfiesVersion(ver, p.range)
    return true
  }

  // Package manager detection override
  const managers: PackageManager[] =
    Array.isArray(p.manager) ? p.manager
    : p.manager ? [p.manager]
    : [pm]
  for (const m of managers) {
    const ver = await queryPackageVersion(ctx, family, m, p.name)
    if (!ver) continue
    if (p.version && !verEquals(ver, p.version)) continue
    if (p.range && !(await satisfiesVersion(ver, p.range))) continue
    return true
  }
  return false
}

async function detectPackageManager(
  ctx: Katmer.TaskContext<any>,
  family: OsFamily | "unknown"
): Promise<PackageManager> {
  if (family === "windows") {
    // prefer winget, then choco
    if (
      (
        await ctx.exec(
          `powershell -Command "Get-Command winget -ErrorAction SilentlyContinue"`
        )
      ).code === 0
    )
      return "winget"
    if (
      (
        await ctx.exec(
          `powershell -Command "Get-Command choco -ErrorAction SilentlyContinue"`
        )
      ).code === 0
    )
      return "choco"
    return "unknown"
  }
  // POSIX probes
  if ((await ctx.exec(`sh -lc 'command -v apt >/dev/null 2>&1'`)).code === 0)
    return "apt"
  if ((await ctx.exec(`sh -lc 'command -v dnf >/dev/null 2>&1'`)).code === 0)
    return "dnf"
  if ((await ctx.exec(`sh -lc 'command -v yum >/dev/null 2>&1'`)).code === 0)
    return "yum"
  if ((await ctx.exec(`sh -lc 'command -v zypper >/dev/null 2>&1'`)).code === 0)
    return "zypper"
  if ((await ctx.exec(`sh -lc 'command -v apk >/dev/null 2>&1'`)).code === 0)
    return "apk"
  if ((await ctx.exec(`sh -lc 'command -v pacman >/dev/null 2>&1'`)).code === 0)
    return "pacman"
  if ((await ctx.exec(`sh -lc 'command -v brew >/dev/null 2>&1'`)).code === 0)
    return "brew"
  if ((await ctx.exec(`sh -lc 'command -v port >/dev/null 2>&1'`)).code === 0)
    return "port"
  return "unknown"
}

async function queryPackageVersion(
  ctx: Katmer.TaskContext<any>,
  family: OsFamily | "unknown",
  pm: PackageManager,
  name: string
): Promise<string | null> {
  switch (pm) {
    case "apt": {
      // dpkg-query returns 1 when not installed
      const r = await ctx.exec(
        `dpkg-query -W -f='${"${Version}"}' ${shq(name)}`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "dnf": {
      const r = await ctx.exec(
        `rpm -q --qf '%{EPOCH}:%{VERSION}-%{RELEASE}' ${shq(name)}`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "yum": {
      const r = await ctx.exec(
        `rpm -q --qf '%{EPOCH}:%{VERSION}-%{RELEASE}' ${shq(name)}`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "zypper": {
      const r = await ctx.exec(
        `rpm -q --qf '%{EPOCH}:%{VERSION}-%{RELEASE}' ${shq(name)}`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "apk": {
      const r = await ctx.exec(
        `apk info -e ${shq(name)} >/dev/null 2>&1 && apk info -v ${shq(name)}`
      )
      if (r.code !== 0) return null
      // output like: "cron-4.2-r2"
      const line = (r.stdout || "").split(/\r?\n/).find(Boolean) || ""
      return line.replace(/^.*?-/, "") || null
    }
    case "pacman": {
      const r = await ctx.exec(
        `pacman -Qi ${shq(name)} 2>/dev/null | sed -n 's/^Version\\s*:\\s*//p'`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "brew": {
      const r = await ctx.exec(
        `brew list --versions ${shq(name)} 2>/dev/null | awk '{print $2}'`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "port": {
      const r = await ctx.exec(
        `port -q installed ${shq(name)} | awk '{print $2}'`
      )
      return r.code === 0 ? (r.stdout || "").trim() : null
    }
    case "winget": {
      const r = await ctx.exec(
        `powershell -NoProfile -NonInteractive -Command "winget list --id ${name} | Out-String"`
      )
      if (r.code !== 0) return null
      const m = (r.stdout || "").match(/\b(\d+(?:\.\d+){1,3}(?:[-\w\.]+)?)\b/)
      return m?.[1] || null
    }
    case "choco": {
      const r = await ctx.exec(`choco list --local-only --limit-output ${name}`)
      if (r.code !== 0) return null
      const m = (r.stdout || "").trim().match(/^[^|]+\|(.+)$/)
      return m?.[1] || null
    }
    default:
      return null
  }
}

function verEquals(a: string, b: string) {
  // try exact first; if not, compare coerced semver
  if (a === b) return true
  const ca = coerceSemver(a),
    cb = coerceSemver(b)
  return !!(ca && cb && ca === cb)
}

// Very light coercion of distro versions to semver-like
function coerceSemver(v: string): string | null {
  // strip epoch and release: "2:1.17.3-1ubuntu1~22.04.1" -> "1.17.3"
  const m = v.match(/(\d+\.\d+\.\d+|\d+\.\d+|\d+)/)
  return m ? normalizeSemverDigits(m[1]) : null
}
function coerceVersion(v: string): string | null {
  const m = v.match(/(\d+(?:\.\d+){0,3}(?:[-\w\.]+)?)/)
  return m?.[1] || null
}
function normalizeSemverDigits(v: string) {
  const parts = v.split(".").map((x) => x.trim())
  while (parts.length < 3) parts.push("0")
  return parts.slice(0, 3).join(".")
}

async function satisfiesVersion(
  version: string,
  range: string
): Promise<boolean> {
  // Try semver if available
  try {
    const sv = coerceSemver(version)
    const rr = range
    if (sv && semver.valid(sv) && semver.validRange(rr)) {
      return semver.satisfies(sv, rr)
    }
  } catch (_) {
    // ignore; fall back
  }
  // Fallback: support simple comparators like ">=1.2.3", "<2.0.0", "==1.5.0", multiple separated by space
  const sv = coerceSemver(version) || version
  return simpleRangeSatisfies(sv, range)
}

function simpleRangeSatisfies(v: string, range: string): boolean {
  const clauses = range.split(/\s+/).filter(Boolean)
  for (const c of clauses) {
    const m = c.match(/^(<=|>=|<|>|=|==)?\s*([^\s]+)$/)
    if (!m) continue
    const op = m[1] || "=="
    const target = m[2]
    if (!cmp(v, target, op)) return false
  }
  return true
}

// naive comparator using dotted-number compare on first 3 segments
function cmp(a: string, b: string, op: string): boolean {
  const na = (coerceSemver(a) || a).split(".").map((n) => parseInt(n, 10) || 0)
  const nb = (coerceSemver(b) || b).split(".").map((n) => parseInt(n, 10) || 0)
  while (na.length < 3) na.push(0)
  while (nb.length < 3) nb.push(0)
  const c = na[0] - nb[0] || na[1] - nb[1] || na[2] - nb[2]
  switch (op) {
    case ">":
      return c > 0
    case ">=":
      return c >= 0
    case "<":
      return c < 0
    case "<=":
      return c <= 0
    case "=":
    case "==":
      return c === 0
    default:
      return false
  }
}

function shq(s: string) {
  return s.replace(/'/g, "'\"'\"'")
}

function normalizePackageList(
  pkgs?: Array<PackageConstraint | string>
): PackageConstraint[] {
  if (!pkgs?.length) return []
  return pkgs.map(normalizePackageEntry)
}
function normalizePackageEntry(
  p: PackageConstraint | string
): PackageConstraint {
  if (typeof p !== "string") return p

  const s = p.trim()
  // Preferred: "name@<range>"
  const at = s.indexOf("@")
  if (at > 0) {
    const name = s.slice(0, at).trim()
    const range = s.slice(at + 1).trim()
    return range ? { name, range } : { name }
  }

  // Lenient: "name <range...>" e.g., "cron >=3.0"
  const m = s.match(/^([^\s]+)\s+(.+)$/)
  if (m) {
    const [, name, range] = m
    return { name, range: range.trim() }
  }

  // Just a name
  return { name: s }
}
