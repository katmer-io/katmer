// src/modules/gather/fastfetch_facts.module.ts
import path from "node:path"
import os from "node:os"
import fs from "fs-extra"
import crypto from "node:crypto"
import AdmZip from "adm-zip"
import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../katmer"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { SSHProvider } from "../providers/ssh/ssh.provider"
import { LocalProvider } from "../providers/local.provider"
import { KatmerModule } from "../module"

type OsKey = "linux" | "darwin" | "windows"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      gather_facts?: GatherFactsModuleOptions
    }
  }
}
/**
 * You can pass `true` to use sensible defaults with controller caching and target-side persistence.
 * If a string array is provided, it will be used as the `modules` list.
 */
export type GatherFactsModuleOptions =
  | {
      /**
       * fastfetch modules to fetch. See https://github.com/fastfetch-cli/fastfetch/wiki/Support+Status#available-modules for available modules.
       * @defaultValue ["bios","board","cpu","cpucache","datetime","disk","dns","gpu","host","initsystem","kernel","locale","localip","memory","os","packages","physicaldisk","publicip","shell","swap","terminal","title","tpm","uptime","users","version","wifi"]
       */
      modules: string[]
      /**
       * GitHub tag to use (e.g., `"2.16.0"`).
       * If omitted, the module uses the **latest release**, subject to the local release cache
       * controlled by {@link GatherFactsModuleOptions.release_ttl_days | `release_ttl_days`}.
       */
      version?: string
      /**
       * Directory on the **controller** where release metadata and downloaded zip files are cached.
       * @defaultValue system temp dir, e.g. `os.tmpdir()/katmer-fastfetch-cache`
       */
      cache_dir?: string
      /**
       * Time-to-live (in days) for the local **release metadata** cache.
       * Within this period, the module avoids querying GitHub’s API again.
       * @defaultValue 3
       */
      release_ttl_days?: number
      /**
       * Persistent directory on the **target** where the fastfetch binary is placed.
       * If the same version already exists there, upload/download is skipped.
       * @defaultValue POSIX: `~/.katmer/bin` • Windows: `%USERPROFILE%\.katmer\bin`
       */
      target_dir?: string
      /**
       * When the provider OS cannot be determined, try all supported OS binaries (linux/darwin/windows)
       * in that order until one succeeds.
       * @defaultValue true
       */
      fallback_when_unknown?: boolean
    }
  | boolean
  | string[]

export interface GatherFactsModuleResult extends ModuleCommonReturn {
  /** Mapped fastfetch `--format json` output to `{ [type|lowercase]: result }` */
  facts?: Record<string, any>
  /** Which OS binary ran successfully */
  used_os?: OsKey
  /** Release version/tag used */
  version?: string
}

const GITHUB_API =
  "https://api.github.com/repos/fastfetch-cli/fastfetch/releases"

/**
 * Gather target facts using the [**fastfetch** CLI](https://github.com/fastfetch-cli/fastfetch) (zero external deps on the target).
 *
 * @remarks
 * - The module **fetches a prebuilt fastfetch binary from GitHub Releases** (once, with a TTL cache on the controller),
 *   uploads (or remote-downloads) the matching binary to the target into a persistent directory
 *   (e.g. `~/.katmer/bin` on POSIX or `%USERPROFILE%\.katmer\bin` on Windows), and runs it with `--format json`.
 * - It relies on the provider's pre-detected OS/arch to pick the right asset.
 *   If the OS is unknown and {@link GatherFactsModuleOptions.fallback_when_unknown | `fallback_when_unknown`} is true,
 *   it will **try all supported OS binaries** (linux → darwin → windows) until one succeeds.
 * - **Idempotent on target**: if the same fastfetch version already exists on the target path, the binary won't be re-uploaded/re-downloaded.
 * - **Cached on controller**: GitHub releases and zip payloads are cached locally under {@link GatherFactsModuleOptions.cache_dir | `cache_dir`}.
 *   Releases are re-queried only after {@link GatherFactsModuleOptions.release_ttl_days | `release_ttl_days`} days.
 * - Works with both **SSH** and **Local** providers:
 *   - SSH: uploads to `~/.katmer/bin/fastfetch[-os].exe` (or remote-downloads if upload fails).
 *   - Local: runs the cached controller binary directly (still keeps controller cache/TTL).
 *
 * @examples
 * ```yaml
 * - name: Gather target facts via fastfetch
 *   gather_facts:
 *     version: "2.16.0"              # optional, defaults to cached-latest within TTL
 *     cache_dir: "/var/cache/katmer" # controller cache for releases & zips
 *     release_ttl_days: 3            # only re-check GitHub after 3 days
 *     target_dir: "~/.katmer/bin"    # where the binary lives on target
 *
 * - name: Fallback across OSes (OS unknown → try all; darwin wins)
 *   gather_facts:
 *     fallback_when_unknown: true
 *
 * - name: Gather facts on localhost
 *   targets: local
 *   gather_facts:
 *     release_ttl_days: 5
 * ```
 *
 */
export class GatherFactsModule extends KatmerModule<
  GatherFactsModuleOptions,
  GatherFactsModuleResult,
  KatmerProvider
> {
  static name = "gather_facts" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  async check(): Promise<void> {}
  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}

  async execute(ctx: Katmer.TaskContext): Promise<GatherFactsModuleResult> {
    const defaultModules = [
      "bios",
      "board",
      "cpu",
      "cpucache",
      "datetime",
      "disk",
      "dns",
      "gpu",
      "host",
      "initsystem",
      "kernel",
      "locale",
      "localip",
      "memory",
      "os",
      "packages",
      "physicaldisk",
      "publicip",
      "shell",
      "swap",
      "terminal",
      "title",
      "tpm",
      "uptime",
      "users",
      "version",
      "wifi"
    ]
    const opts = Object.assign(
      {
        cache_dir: path.join(os.tmpdir(), "katmer-fastfetch-cache"),
        release_ttl_days: 3,
        fallback_when_unknown: true
      },
      Array.isArray(this.params) ? { modules: this.params }
      : typeof this.params !== "boolean" ? this.params
      : {
          modules: defaultModules
        }
    )

    if (!opts.modules || opts.modules.length === 0) {
      return {
        changed: false,
        failed: true,
        msg: "fastfetch facts: no modules specified"
      }
    }

    const fFetchArgs = `--format json --structure ${opts.modules.join(":")}`

    // 1) Decide OS from provider (set during connect/ensureReady)
    const fam = (ctx.provider.os?.family || "unknown") as
      | "linux"
      | "darwin"
      | "windows"
      | "unknown"
    const arch = (ctx.provider.os?.arch || "").toLowerCase()

    // 2) Resolve release info with controller-side TTL cache
    const rel = await resolveReleaseCached(
      opts.version,
      opts.cache_dir,
      opts.release_ttl_days
    )

    // 3) Compute desired OS order
    const primaryOs: OsKey | undefined =
      fam === "linux" ? "linux"
      : fam === "darwin" ? "darwin"
      : fam === "windows" ? "windows"
      : undefined

    const order: OsKey[] =
      primaryOs ?
        ([
          primaryOs,
          ...(["linux", "darwin", "windows"] as OsKey[]).filter(
            (k) => k !== primaryOs
          )
        ] as OsKey[])
      : opts.fallback_when_unknown ? (["linux", "darwin", "windows"] as OsKey[])
      : []

    if (order.length === 0) {
      return {
        changed: false,
        failed: true,
        msg: "fastfetch facts: target OS could not be determined and fallback disabled"
      }
    }

    // 4) Run per-provider flow
    if (ctx.provider instanceof LocalProvider) {
      // Local: ensure local binary, then run directly
      const localOs: OsKey =
        process.platform === "win32" ? "windows"
        : process.platform === "darwin" ? "darwin"
        : "linux"
      const asset = pickAssetFor(rel, localOs, normalizeNodeArch(process.arch))
      const binPath = await ensureLocalBinary(opts.cache_dir, localOs, asset)
      const runCmd =
        localOs === "windows" ?
          `${sh(binPath)} ${fFetchArgs}`
        : `${sh(binPath)} ${fFetchArgs}`

      const r = await ctx.execSafe(runCmd)
      const facts = parseFacts(r.stdout?.trim() || "")
      if (r.code === 0 && facts) {
        return {
          changed: false,
          facts,
          used_os: localOs,
          version: rel.tag_name
        }
      }
      return {
        changed: false,
        failed: true,
        msg: `fastfetch failed locally: ${(r.stderr || r.stdout || "").trim()}`
      }
    }

    if (!(ctx.provider instanceof SSHProvider)) {
      return {
        changed: false,
        failed: true,
        msg: "fastfetch facts: unsupported provider"
      }
    }

    // SSH: For each OS in order, ensure (via remote download to target dir) and run
    for (const osKey of order) {
      const asset = pickAssetFor(rel, osKey, arch)
      if (!asset) continue

      try {
        const binPath =
          osKey === "windows" ?
            await ensureRemoteWindows(
              ctx,
              asset.browser_download_url,
              rel.tag_name,
              opts.target_dir
            )
          : await ensureRemotePosix(
              ctx,
              asset.browser_download_url,
              rel.tag_name,
              opts.target_dir
            )

        const r =
          osKey === "windows" ?
            await psRaw(ctx, `& ${psq(binPath)} ${fFetchArgs}`)
          : await ctx.execSafe(`${sh(binPath)} ${fFetchArgs}`)

        const facts = parseFacts(r.stdout?.trim() || "")
        if (r.code === 0 && facts) {
          return {
            changed: false,
            facts,
            used_os: osKey,
            version: rel.tag_name
          }
        }
      } catch (e: any) {
        // try next OS if fallback is enabled
        ctx.logger?.debug?.({
          msg: `fastfetch ${osKey} path failed`,
          error: String(e)
        })
      }
    }

    return {
      changed: false,
      failed: true,
      msg: "fastfetch failed on target for all attempted OS paths"
    }
  }
}

/* ───────────────────────── controller-side helpers ───────────────────────── */

function rand() {
  return crypto.randomBytes(5).toString("hex")
}
function sh(p: string) {
  return JSON.stringify(p)
}
function psq(s: string) {
  return `'${String(s).replace(/'/g, "''")}'`
}

function normalizeNodeArch(a: NodeJS.Process["arch"]): string {
  switch (a) {
    case "x64":
      return "x86_64"
    case "arm64":
      return "arm64"
    case "arm":
      return "arm"
    case "ia32":
      return "i386"
    default:
      return a
  }
}

async function resolveReleaseCached(
  version: string | undefined,
  cacheDir: string,
  ttlDays: number
): Promise<{
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string }>
}> {
  const relDir = path.join(cacheDir, "releases")
  await fs.ensureDir(relDir)
  const key = version ? `tag-${version}` : "latest"
  const cacheFile = path.join(relDir, `${key}.json`)

  const now = Date.now()
  const ttlMs = Math.max(1, ttlDays) * 24 * 3600 * 1000

  if (await fs.pathExists(cacheFile)) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
        fetchedAt: number
        data: {
          tag_name: string
          assets: Array<{ name: string; browser_download_url: string }>
        }
      }
      if (
        cached?.fetchedAt &&
        now - cached.fetchedAt < ttlMs &&
        cached.data?.tag_name
      ) {
        return cached.data
      }
    } catch {
      // ignore; will refetch
    }
  }

  const url =
    version ?
      `${GITHUB_API}/tags/${encodeURIComponent(version)}`
    : `${GITHUB_API}/latest`
  const r = await fetch(url, { headers: { "User-Agent": "katmer-fastfetch" } })
  if (!r.ok)
    throw new Error(`GitHub releases fetch failed: ${r.status} ${r.statusText}`)
  const data = (await r.json()) as {
    tag_name: string
    assets: Array<{ name: string; browser_download_url: string }>
  }

  await fs.writeFile(
    cacheFile,
    JSON.stringify({ fetchedAt: now, data }),
    "utf8"
  )
  return data
}

/**
 * Choose the best matching asset for a given OS + arch.
 * First try strict OS+ARCH zip names, then fall back to OS-only.
 * Throws if not found.
 */
function pickAssetFor(
  rel: {
    tag_name: string
    assets: Array<{ name: string; browser_download_url: string }>
  },
  osKey: OsKey,
  arch: string
) {
  const list = rel.assets
  const archTokens = tokensForArch(arch)

  const osExpr =
    osKey === "darwin" ? "(macos|darwin)"
    : osKey === "windows" ? "(windows|win)"
    : "linux"

  const strict = archTokens.map(
    (t) => new RegExp(`fastfetch-${osExpr}-${t}\\.zip$`, "i")
  )
  for (const a of list) {
    if (strict.some((rx) => rx.test(a.name))) return a
  }

  // fallback looser zip names (just OS mention and ".zip")
  const loose = new RegExp(`(${osExpr}).*\\.zip$`, "i")
  const found = list.find((a) => loose.test(a.name))
  if (found) return found

  throw new Error(`could not find fastfetch asset for ${osKey}-${arch}`)
}

function tokensForArch(arch: string): string[] {
  const a = arch.toLowerCase()
  if (/^(x64|x86_64|amd64)$/.test(a)) return ["x86_64", "amd64", "x64"]
  if (/^(aarch64|arm64)$/.test(a)) return ["aarch64", "arm64"]
  if (/^(arm|armv7|armhf)$/.test(a)) return ["armv7", "armhf", "arm"]
  if (/^(i386|x86|386)$/.test(a)) return ["i386", "x86", "386"]
  return [a]
}

/**
 * Controller-side ensure + extract (used by LocalProvider).
 * Writes the binary into `${cacheDir}/bin/fastfetch-{os}` (or .exe).
 */
async function ensureLocalBinary(
  cacheDir: string,
  osKey: OsKey,
  asset: { name: string; browser_download_url: string }
) {
  const dlDir = path.join(cacheDir, "downloads")
  const binDir = path.join(cacheDir, "bin")
  await fs.ensureDir(dlDir)
  await fs.ensureDir(binDir)

  const zipPath = path.join(dlDir, asset.name)
  if (!(await fs.pathExists(zipPath))) {
    const buf = await (
      await fetch(asset.browser_download_url, {
        headers: { "User-Agent": "katmer-fastfetch" }
      })
    ).arrayBuffer()
    await fs.writeFile(zipPath, Buffer.from(buf))
  }

  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries() as any[]
  const target = entries.find((e) => {
    const n = String(e.entryName)
    return (
      /(^|\/)fastfetch(\.exe)?$/i.test(n) || /(^|\/)bin\/fastfetch$/i.test(n)
    )
  })
  if (!target) throw new Error(`Binary not found inside ${asset.name}`)

  const outPath = path.join(
    binDir,
    osKey === "windows" ? "fastfetch.exe" : `fastfetch-${osKey}`
  )
  await fs.writeFile(outPath, target.getData())
  if (osKey !== "windows") await fs.chmod(outPath, 0o755)
  return outPath
}

/* ───────────────────────── remote (SSH) ensure helpers ───────────────────────── */

async function ensureRemotePosix(
  ctx: Katmer.TaskContext,
  assetUrl: string,
  versionTag: string,
  explicitTargetDir?: string
): Promise<string> {
  // Will install to $HOME/.katmer/bin (or explicitTargetDir), keep fastfetch.version for idempotency.
  const id = rand()
  const cmd = [
    `URL=${sh(assetUrl)}; TAG=${sh(versionTag)};`,
    `HOME_DIR="\${HOME:-$PWD}";`,
    explicitTargetDir ?
      `T=${sh(explicitTargetDir)};`
    : `T="$HOME_DIR/.katmer/bin";`,
    `mkdir -p "$T";`,
    `BIN="$T/fastfetch"; VER="$T/fastfetch.version";`,
    `[ -x "$BIN" ] && [ -f "$VER" ] && [ "$(cat "$VER")" = "$TAG" ] && { echo "$BIN"; exit 0; };`,
    `TMP="$(mktemp -d)"; ZIP="$TMP/ff.zip";`,
    `if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$ZIP" "$URL";`,
    `elif command -v wget >/dev/null 2>&1; then wget -qO "$ZIP" "$URL";`,
    `else echo "no curl/wget found" >&2; rm -rf "$TMP"; exit 90; fi;`,
    `if command -v unzip >/dev/null 2>&1; then unzip -o "$ZIP" -d "$TMP" >/dev/null;`,
    `elif command -v busybox >/dev/null 2>&1; then busybox unzip "$ZIP" -d "$TMP" >/dev/null;`,
    `else echo "no unzip available" >&2; rm -rf "$TMP"; exit 91; fi;`,
    `F="$(find "$TMP" -type f \\( -name fastfetch -o -name fastfetch.exe \\) | head -n1)";`,
    `[ -z "$F" ] && { echo "binary not found" >&2; rm -rf "$TMP"; exit 92; };`,
    `install -D -m 0755 "$F" "$BIN";`,
    `printf "%s" "$TAG" > "$VER";`,
    `rm -rf "$TMP";`,
    `echo "$BIN"`
  ].join(" ")

  const r = await ctx.execSafe(cmd)
  if (r.code !== 0 || !r.stdout?.trim()) {
    throw new Error(
      (r.stderr || r.stdout || `posix ensure failed (${r.code})`).trim()
    )
  }
  return r.stdout.trim().split(/\r?\n/).slice(-1)[0] // last echo
}

async function ensureRemoteWindows(
  ctx: Katmer.TaskContext,
  assetUrl: string,
  versionTag: string,
  explicitTargetDir?: string
): Promise<string> {
  const script = `
    $ErrorActionPreference='Stop';
    $URL = ${psq(assetUrl)};
    $TAG = ${psq(versionTag)};
    $HOME = $env:USERPROFILE;
    $T = ${explicitTargetDir ? psq(explicitTargetDir) : `Join-Path $HOME ".katmer\\bin"`};
    $BIN = Join-Path $T "fastfetch.exe";
    $VER = Join-Path $T "fastfetch.version";
    New-Item -ItemType Directory -Force -Path $T | Out-Null;
    if ((Test-Path $BIN) -and (Test-Path $VER) -and ((Get-Content $VER -Raw).Trim() -eq $TAG)) {
      Write-Output $BIN; exit 0
    }
    $zip = Join-Path $env:TEMP ("ff_" + [guid]::NewGuid().ToString() + ".zip");
    Invoke-WebRequest -Uri $URL -OutFile $zip -UseBasicParsing;
    $tmpDir = Join-Path $env:TEMP ("ff_" + [guid]::NewGuid().ToString());
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpDir);
    $ff = Get-ChildItem -Path $tmpDir -Recurse -File -Filter fastfetch.exe | Select-Object -First 1;
    if (-not $ff) { throw "fastfetch.exe not found in zip" }
    New-Item -ItemType Directory -Force -Path $T | Out-Null;
    Copy-Item -Force $ff.FullName $BIN;
    Set-Content -Path $VER -Value $TAG -NoNewline;
    Remove-Item -Recurse -Force $tmpDir; Remove-Item -Force $zip;
    Write-Output $BIN
  `
  const r = await psRaw(ctx, script)
  if (r.code !== 0 || !r.stdout?.trim()) {
    throw new Error(
      (r.stderr || r.stdout || `windows ensure failed (${r.code})`).trim()
    )
  }
  return r.stdout.trim().split(/\r?\n/).slice(-1)[0]
}

/* Windows runner helper (SSH) */
async function psRaw(ctx: Katmer.TaskContext, script: string) {
  const wrapped = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${psq(script)}`
  return ctx.execSafe(wrapped)
}

/* ───────────────────────── parsing ───────────────────────── */

/**
 * fastfetch --format json output is typically an array of { type, result }.
 * We normalize into an object keyed by lowercased type.
 */
function parseFacts(s: string) {
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed)) {
      return parsed.reduce<Record<string, any>>((acc, item) => {
        if (item.type) {
          if (item.result) {
            acc[String(item.type).toLowerCase()] = item.result
          } else {
            acc[String(item.type).toLowerCase()] = item
          }
        }
        return acc
      }, {})
    }
  } catch {}
  return undefined
}
