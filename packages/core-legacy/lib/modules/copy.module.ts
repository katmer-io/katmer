import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import fs from "fs-extra"
import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../katmer"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { SSHProvider } from "../providers/ssh/ssh.provider"
import { LocalProvider } from "../providers/local.provider"
import { evalTemplate } from "../utils/renderer/renderer"
import { exec as execCb } from "node:child_process"
import { promisify } from "node:util"
import { toOctal } from "../utils/number.utils"
import { UnixComms } from "../utils/unix.utils"
import { WindowsComms } from "../utils/windows.utils"
import { KatmerModule } from "../module"

const exec = promisify(execCb)

const REMOTE_STAGE_DIR = "/tmp"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      copy?: CopyModuleOptions
    }
  }
}
/**
 * Options for the {@link CopyModule | `copy`} module.
 *
 * Copies **content** or a **file** to a destination path.
 *
 * - If {@link CopyModuleOptions.content | `content`} is set, it is rendered **locally** using Twig
 *   against context and written to {@link CopyModuleOptions.dest | `dest`}.
 * - If {@link CopyModuleOptions.src | `src`} is set:
 *   - With **SSH** provider, it is treated as a **controller (local)** path and uploaded to the remote host,
 *     unless {@link CopyModuleOptions.remote_src | `remote_src`} is `true`.
 *   - With **Local** provider, it is a path on the **same machine**.
 * - If {@link CopyModuleOptions.remote_src | `remote_src`} is `true` (SSH only), the copy happens **remote→remote** using shell.
 * - If both `src` and `content` are set, the task fails.
 *
 * @public
 */
export interface CopyModuleOptions {
  /**
   * Source path.
   * - **SSH** (default): controller → remote upload (uses NodeSSH).
   * - **SSH + `remote_src: true`**: remote → remote via shell (`cp`).
   * - **Local**: local → local.
   */
  src?: string

  /**
   * Inline content to write (templated).
   * If a `string`, it is rendered using Twig; if a `Uint8Array`, it is written raw.
   * Mutually exclusive with {@link CopyModuleOptions.src | `src`}.
   */
  content?: string | Uint8Array

  /**
   * Destination path (absolute recommended).
   * - **SSH**: path on the target host.
   * - **Local**: local filesystem path.
   */
  dest: string

  /**
   * Ensure parent directories exist before writing.
   * - **SSH**: `mkdir -p`
   * - **Local**: `fs.ensureDir`
   * @defaultValue true
   */
  parents?: boolean

  /**
   * Treat {@link CopyModuleOptions.src | `src`} as a **remote** path and perform remote→remote copy.
   * Only valid for **SSH** provider.
   * @defaultValue false
   */
  remote_src?: boolean

  /**
   * If `true`, overwrite even when content is identical (still creates backup if requested).
   * When `false`, the module is idempotent and avoids rewriting unchanged files.
   * @defaultValue false
   */
  force?: boolean

  /**
   * When `true`, saves a timestamped backup of the existing `dest` before overwrite.
   * The resulting path is returned in {@link CopyModuleResult.backup_file | `backup_file`}.
   * @defaultValue false
   */
  backup?: boolean

  /**
   * Validate the **staged temporary file** before placing it.
   * The command is executed against the staged file:
   * - If the template contains `%s`, it is replaced with the temp filename.
   * - Otherwise the temp filename is appended as the last argument.
   *
   * Only after a **zero exit code** will the temp file be moved to `dest`.
   *
   * @example
   * Validate an nginx config before replacing:
   * ```yaml
   * copy:
   *   src: ./nginx.conf
   *   dest: /etc/nginx/nginx.conf
   *   validate: "nginx -t -c %s"
   * ```
   */
  validate?: string

  /**
   * File mode for `dest`. Accepts octal `string` (e.g. `"0644"`) or number (e.g. `0o644`).
   * - **SSH**: applied via `chmod`.
   * - **Local**: applied via `fs.chmod`.
   */
  mode?: string | number

  /**
   * File owner for `dest` (`chown owner[:group]`).
   * - **SSH**: may be a name (e.g. `"root"`).
   * - **Local**: POSIX only; names are resolved via `/etc/passwd`, otherwise numeric `uid` is expected.
   */
  owner?: string

  /**
   * File group for `dest` (`chown :group`).
   * - **SSH**: may be a name (e.g. `"www-data"`).
   * - **Local**: POSIX only; names are resolved via `/etc/group`, otherwise numeric `gid` is expected.
   */
  group?: string
}

/**
 * Result returned by the {@link CopyModule | `copy`} module.
 *
 * @public
 */
export interface CopyModuleResult extends ModuleCommonReturn {
  /** Destination path written/examined. */
  dest: string
  /** SHA-256 hex digest of the final file, when determinable. */
  checksum?: string
  /** Backup file path when `backup: true` and an overwrite occurred. */
  backup_file?: string
  /** Whether the `validate` command was executed and passed. */
  validated?: boolean
}

/**
 * Copy files or inline content to a destination, with idempotency, optional validation,
 * and metadata management (mode/owner/group).
 *
 * @remarks
 * **Behavior by provider**
 * - **SSH**:
 *   - Ensures parent directory with `mkdir -p` when `parents: true`.
 *   - Stages to a remote temp file (upload or `cp` for remote_src), validates, then moves into place atomically.
 *   - Applies `chmod`/`chown` via shell when requested.
 *   - Computes SHA-256 using `sha256sum`/`shasum -a 256` if available.
 * - **Local**:
 *   - Uses pure Node.js (`fs.ensureDir`, `fs.move`, `fs.chmod`, `fs.chown`).
 *   - Owner/group resolution reads `/etc/passwd` and `/etc/group` (POSIX).
 *   - Computes SHA-256 by streaming the file via Node crypto.
 *
 * **Idempotency**
 * - When `force: false` (default), compares the incoming staged file hash with the current `dest` hash.
 *   If equal, the write is skipped and `changed=false`.
 *
 * **Validation**
 * - If {@link CopyModuleOptions.validate | `validate`} is defined, the command runs against the staged file.
 *   Only a zero exit code allows the replacement to proceed.
 *
 * @examples
 * ```yaml
 * - name: Copy a local file to remote, idempotent, set permissions
 *   copy:
 *     src: ./conf/app.conf
 *     dest: /etc/myapp/app.conf
 *     mode: "0644"
 *     owner: root
 *     group: root
 *
 * - name: Render robots.txt
 *   copy:
 *     content: |
 *       User-agent: *
 *       Disallow: {{ disallow ? '/' : '' }}
 *     dest: /var/www/robots.txt
 *
 * - name: Copy generated file on remote host
 *   copy:
 *     src: /tmp/generated.cfg
 *     dest: /etc/myapp/generated.cfg
 *     remote_src: true
 * ```
 *
 * @public
 */
export class CopyModule extends KatmerModule<
  CopyModuleOptions,
  CopyModuleResult,
  KatmerProvider
> {
  static name = "copy" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  /**
   * Validate parameters before execution.
   *
   * @throws Error if:
   * - Both {@link CopyModuleOptions.content | `content`} and {@link CopyModuleOptions.src | `src`} are set.
   * - {@link CopyModuleOptions.dest | `dest`} is missing or empty.
   */
  async check(_ctx: Katmer.TaskContext) {
    if (this.params.content != null && this.params.src != null) {
      throw new Error("copy: 'content' and 'src' are mutually exclusive.")
    }
    if (!this.params.dest) {
      throw new Error("copy: 'dest' is required.")
    }
  }

  /** Initialize resources (no-op). */
  async initialize(_ctx: Katmer.TaskContext) {}
  /** Cleanup resources (no-op). */
  async cleanup(_ctx: Katmer.TaskContext) {}

  /**
   * Execute the copy:
   * - Renders string fields (including `content`) against context.
   * - Branches to SSH or Local implementation.
   * - Returns {@link CopyModuleResult} with `changed`, `checksum`, optional `backup_file`, etc.
   */
  async execute(ctx: Katmer.TaskContext): Promise<CopyModuleResult> {
    const p = await this.renderFields(this.params, ctx)

    try {
      if (ctx.provider instanceof SSHProvider) {
        return await this.runSsh(ctx as Katmer.TaskContext<SSHProvider>, p)
      } else if (ctx.provider instanceof LocalProvider) {
        return await this.runLocal(ctx, p)
      }
      throw new Error(
        `copy: unsupported provider ${ctx.provider?.constructor?.name}`
      )
    } catch (err: any) {
      return {
        changed: false,
        failed: true,
        msg: err?.message || String(err),
        dest: p.dest
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────
  // Provider paths
  // ────────────────────────────────────────────────────────────────────────────────

  /**
   * Local provider path:
   * - Ensures parent dir
   * - Stages to a temp file (from `content` or `src`)
   * - Optional validation
   * - Optional backup
   * - Atomic move to `dest`
   * - Apply `mode` and `owner`/`group` via Node APIs
   *
   * @internal
   */
  private async runLocal(
    ctx: Katmer.TaskContext<LocalProvider>,
    p: RequiredSome<CopyModuleOptions, "dest">
  ): Promise<CopyModuleResult> {
    const parents = p.parents ?? true
    const force = !!p.force
    const doBackup = !!p.backup
    const dest = p.dest

    if (parents) await fs.ensureDir(path.dirname(dest))

    const existsBefore = await fs.pathExists(dest)
    const prevHash = existsBefore ? await sha256FileLocal(dest) : null

    let tmpPath: string | null = null
    if (p.content != null) {
      tmpPath = await writeTempLocal(p.content)
    } else if (p.src) {
      tmpPath = await writeTempLocal(await fs.readFile(p.src))
    } else if (p.remote_src) {
      throw new Error("copy: 'remote_src' is only valid with SSH provider.")
    } else {
      throw new Error("copy: one of 'content' or 'src' must be provided.")
    }

    // Idempotency: compare hashes if dest exists and not forced
    let changed = true
    if (existsBefore && !force) {
      const incomingHash = await sha256FileLocal(tmpPath!)
      if (prevHash && incomingHash && prevHash === incomingHash) {
        changed = false
      }
    }

    // Validate against temp file
    if (p.validate && tmpPath) {
      await validateLocalViaExec(p.validate, tmpPath)
    }

    // Backup before replace
    let backup_file: string | undefined
    if (doBackup && existsBefore && changed) {
      backup_file = `${dest}.${timestamp()}.bak`
      await fs.copy(dest, backup_file, {
        preserveTimestamps: true,
        errorOnExist: false
      })
    }

    // Move staged into place atomically
    if (changed && tmpPath) {
      await fs.move(tmpPath, dest, { overwrite: true })
      tmpPath = null
    } else if (tmpPath) {
      await fs.remove(tmpPath)
      tmpPath = null
    }

    // Apply mode (Node API)
    if (process.platform === "win32") {
      // skip chmod on Windows
    } else if (p.mode != null) {
      try {
        await fs.chmod(dest, parseMode(p.mode))
      } catch (e) {
        ctx.logger?.warn?.({
          msg: `copy(local): chmod failed: ${String(e)}`
        })
      }
    }

    // Apply owner/group (POSIX)
    if (process.platform === "win32") {
      // skip on Windows
    } else if (p.owner != null || p.group != null) {
      try {
        const ids = await toUidGid(p.owner, p.group, ctx)
        if (ids) {
          await fs.chown(
            dest,
            ids.uid ?? (await currentUid()),
            ids.gid ?? (await currentGid())
          )
        } else {
          ctx.logger?.warn?.({
            msg: "copy(local): could not resolve owner/group; skipping chown"
          })
        }
      } catch (e) {
        // On Windows or unsupported FS, chown may throw — log and continue
        ctx.logger?.warn?.({
          msg: `copy(local): chown failed: ${String(e)}`
        })
      }
    }

    const finalHash =
      (await fs.pathExists(dest)) ? await sha256FileLocal(dest) : null

    return {
      changed,
      failed: false,
      dest,
      checksum: finalHash ?? undefined,
      backup_file,
      validated: !!p.validate
    }
  }

  /**
   * SSH provider path:
   * - Ensures parent dir
   * - Stages to a remote temp file (upload or remote `cp`)
   * - Idempotency by remote hash
   * - Optional validation on staged temp file
   * - Optional backup
   * - Atomic `mv` into place
   * - Apply `mode` / `owner` / `group` via shell
   *
   * @internal
   */
  private async runSsh(
    ctx: Katmer.TaskContext<SSHProvider>,
    p: RequiredSome<CopyModuleOptions, "dest">
  ): Promise<CopyModuleResult> {
    const osfam = ctx.provider.os.family as string

    const parents = p.parents ?? true
    const force = !!p.force
    const doBackup = !!p.backup
    const dest = p.dest
    const client = ctx.provider.client!

    // Ensure parent of dest exists (runs via shell; your become wrapper applies here)
    if (parents) {
      if (osfam === "windows") {
        await WindowsComms.ensureDir(
          ctx,
          dest.replace(/\\/g, "/").replace(/\/[^/]*$/, "")
        )
      } else {
        await ctx.exec(`mkdir -p -- $(dirname -- ${JSON.stringify(dest)})`)
      }
    }

    // Existing dest hash (if any)
    const existed = await UnixComms.fileExists(ctx, dest)
    const prevHash = existed ? await sha256FileRemote(ctx, dest) : null

    // Always stage in a user-writable directory to avoid SFTP permission problems
    const remoteTmp = path.posix.join(
      REMOTE_STAGE_DIR,
      `katmer-copy-${randomId()}`
    )
    let staged = false

    // ---- Stage content/file into /tmp (SFTP for local->remote; cp for remote_src) ----
    if (p.content != null) {
      const tmp = await writeTempLocal(p.content)
      try {
        await client.putFile(tmp, remoteTmp) // SFTP never needs sudo; /tmp is writable
        staged = true
      } finally {
        await fs.remove(tmp)
      }
    } else if (p.src && !p.remote_src) {
      if (osfam === "windows") {
        // PutFile works too, but ensure Windows path separators are handled by node-ssh
        await client.putFile(p.src, remoteTmp)
      } else {
        await client.putFile(p.src, remoteTmp)
      } // controller -> remote:/tmp
      staged = true
    } else if (p.src && p.remote_src) {
      // Remote -> /tmp (shell; become applies as needed for reading src)
      await ctx.exec(
        `cp -f -- ${JSON.stringify(p.src)} ${JSON.stringify(remoteTmp)}`
      )
      staged = true
    } else {
      throw new Error("copy: one of 'content' or 'src' must be provided.")
    }

    // ---- Idempotency (if not forced) compare remote hashes ----
    let changed = true
    if (existed && staged && !force) {
      const incomingHash = await sha256FileRemote(ctx, remoteTmp)
      if (prevHash && incomingHash && prevHash === incomingHash) {
        await ctx.exec(`rm -f -- ${JSON.stringify(remoteTmp)}`)
        staged = false
        changed = false
      }
    }

    // ---- Validate staged file (runs via shell; become applies) ----
    if (staged && p.validate) {
      await validateRemoteViaShell(ctx, p.validate, remoteTmp)
    }

    // ---- Optional backup of current dest ----
    let backup_file: string | undefined
    if (doBackup && existed && changed) {
      backup_file = `${dest}.${timestamp()}.bak`
      await ctx.exec(
        `cp -p -- ${JSON.stringify(dest)}  ${JSON.stringify(backup_file)} `
      )
    }

    // ---- Install into place (atomic as possible) ----
    if (staged && changed) {
      const modeStr = p.mode != null ? toOctal(p.mode) : undefined
      if (modeStr) {
        // Try install first (creates parents, sets mode atomically); fallback to mv+chmod
        await ctx.exec(
          `install -D -m ${modeStr} -- ${JSON.stringify(remoteTmp)} ${JSON.stringify(dest)} || (mv -f -- ${JSON.stringify(remoteTmp)} ${JSON.stringify(dest)} && chmod ${modeStr} -- ${JSON.stringify(dest)})`
        )
      } else {
        await ctx.exec(
          `mv -f -- ${JSON.stringify(remoteTmp)} ${JSON.stringify(dest)}`
        )
      }
    } else if (staged) {
      await ctx.exec(`rm -f -- ${JSON.stringify(remoteTmp)}`)
    }

    // ---- Owner / group (after install), still via shell (become applies) ----
    if (osfam === "windows") {
      // Skip POSIX owner/group/mode. (Future: use icacls to set ACLs if provided.)
    } else {
      if (p.owner || p.group) {
        const who = [p.owner ?? "", p.group ? `:${p.group}` : ""].join("")
        await ctx.exec(`chown ${who} -- ${JSON.stringify(dest)}`)
      }
      if (p.mode != null) {
        await ctx.exec(`chmod ${toOctal(p.mode)} -- ${JSON.stringify(dest)}`)
      }
    }

    // Final hash (best-effort)
    const finalHash =
      osfam === "windows" ? null
      : (await UnixComms.fileExists(ctx, dest)) ?
        await sha256FileRemote(ctx, dest)
      : null

    return {
      changed,
      failed: false,
      dest,
      checksum: finalHash ?? undefined,
      backup_file,
      validated: !!p.validate
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────────

  /**
   * Render only the string-like fields against context.
   * - `content` is rendered only if it is a `string`; `Uint8Array` is passed through untouched.
   *
   * @internal
   */
  private async renderFields(
    input: CopyModuleOptions,
    ctx: Katmer.TaskContext<KatmerProvider>
  ): Promise<RequiredSome<CopyModuleOptions, "dest">> {
    const out: CopyModuleOptions = { ...input }
    const renderIfString = async <T extends string | number | undefined>(
      v?: T
    ): Promise<T> =>
      typeof v === "string" ?
        ((await evalTemplate(v, ctx.variables)) as T)
      : (v as T)

    const absFromCwd = (s?: string) => {
      if (typeof s !== "string" || !s.trim()) return s
      // If already absolute, keep it. Else resolve from config.cwd (fallback to process.cwd()).
      return path.isAbsolute(s) ? s : (
          path.resolve(ctx.config?.cwd ?? process.cwd(), s)
        )
    }

    out.src = absFromCwd(await renderIfString(input.src))
    out.dest = await renderIfString(input.dest)
    out.owner = await renderIfString(input.owner)
    out.group = await renderIfString(input.group)
    out.mode = await renderIfString(input.mode)

    if (typeof input.content === "string") {
      out.content = await renderIfString(input.content)
    } else {
      out.content = input.content
    }

    // Helpful early failure for local→remote branch
    if (!out.content && out.src && !(await fs.pathExists(out.src))) {
      throw new Error(
        `copy: local source not found: ${out.src} (resolved from ${ctx.config?.cwd ?? process.cwd()})`
      )
    }

    if (!out.dest) throw new Error("copy: rendered 'dest' was empty.")
    return out as RequiredSome<CopyModuleOptions, "dest">
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Utility functions (shared)
// ────────────────────────────────────────────────────────────────────────────────

/** @internal */
type RequiredSome<T, K extends keyof T> = T & Required<Pick<T, K>>

/** @internal */
function randomId() {
  return crypto.randomBytes(5).toString("hex")
}
/** @internal */
function timestamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** @internal */
async function writeTempLocal(content: string | Uint8Array): Promise<string> {
  const tmp = path.join(os.tmpdir(), `katmer-copy-${randomId()}`)
  await fs.writeFile(tmp, content)
  return tmp
}

/** @internal */
async function sha256FileLocal(p: string): Promise<string | null> {
  try {
    const hash = crypto.createHash("sha256")
    const s = fs.createReadStream(p)
    await new Promise<void>((resolve, reject) => {
      s.on("data", (c) => hash.update(c))
      s.on("error", reject)
      s.on("end", () => resolve())
    })
    return hash.digest("hex")
  } catch {
    return null
  }
}

/** @internal */
function parseMode(mode: string | number): number {
  if (typeof mode === "number") return mode
  const m = String(mode).trim()
  // accept "0644" or "644"
  const oct = m.startsWith("0") ? m : "0" + m
  return Number.parseInt(oct, 8)
}

/** @internal */
async function sha256FileRemote(
  ctx: Katmer.TaskContext<SSHProvider>,
  p: string
): Promise<string | null> {
  let r = await ctx.execSafe(
    `sha256sum -- ${JSON.stringify(p)} 2>/dev/null || true`
  )
  if (r.code === 0 && r.stdout?.trim()) {
    const m = r.stdout.trim().match(/^([a-f0-9]{64})\s+/i)
    if (m) return m[1].toLowerCase()
  }
  r = await ctx.execSafe(
    `shasum -a 256 -- ${JSON.stringify(p)} 2>/dev/null || true`
  )
  if (r.code === 0 && r.stdout?.trim()) {
    const m = r.stdout.trim().match(/^([a-f0-9]{64})\s+/i)
    if (m) return m[1].toLowerCase()
  }
  return null
}

/** @internal */
async function validateRemoteViaShell(
  ctx: Katmer.TaskContext<SSHProvider>,
  template: string,
  tmpPath: string
) {
  const quoted = JSON.stringify(tmpPath)
  const cmd =
    template.includes("%s") ?
      template.replaceAll("%s", quoted)
    : `${template} ${quoted}`
  const r = await ctx.execSafe(cmd)
  if (r.code) {
    const details = (r.stderr || r.stdout || "").trim()
    throw new Error(
      details ?
        `validate failed: ${details}`
      : `validate failed with code ${r.code}`
    )
  }
}

/** @internal */
async function validateLocalViaExec(template: string, tmpPath: string) {
  const cmd =
    template.includes("%s") ?
      template.replaceAll("%s", tmpPath)
    : `${template} ${tmpPath}`
  // Use a shell because template may contain flags/pipe/redir;
  const { stderr } = await exec(cmd).catch((e: any) => {
    const msg = e?.stderr || e?.stdout || e?.message || String(e)
    const err = new Error(`validate failed: ${msg.trim()}`)
    ;(err as any).code = e?.code
    throw err
  })
  if (stderr && /error/i.test(stderr)) {
    // not fatal by itself; command exit code already handled
  }
}

// POSIX uid/gid resolution via /etc files

/** @internal */
const passwdCache = new Map<string, number>()
/** @internal */
const groupCache = new Map<string, number>()
/** @internal */
let passwdLoaded = false
/** @internal */
let groupLoaded = false

/** @internal */
async function loadEtcPasswd() {
  if (passwdLoaded || process.platform === "win32") return
  try {
    const data = await fs.readFile("/etc/passwd", "utf8")
    for (const line of data.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue
      const [name, , uidStr] = line.split(":")
      const uid = Number.parseInt(uidStr, 10)
      if (!Number.isNaN(uid)) passwdCache.set(name, uid)
    }
  } catch {}
  passwdLoaded = true
}

/** @internal */
async function loadEtcGroup() {
  if (groupLoaded || process.platform === "win32") return
  try {
    const data = await fs.readFile("/etc/group", "utf8")
    for (const line of data.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue
      const [name, , gidStr] = line.split(":")
      const gid = Number.parseInt(gidStr, 10)
      if (!Number.isNaN(gid)) groupCache.set(name, gid)
    }
  } catch {}
  groupLoaded = true
}

/** @internal */
async function currentUid(): Promise<number> {
  try {
    return process.getuid?.() ?? 0
  } catch {
    return 0
  }
}
/** @internal */
async function currentGid(): Promise<number> {
  try {
    return process.getgid?.() ?? 0
  } catch {
    return 0
  }
}

/**
 * Resolve `owner`/`group` to POSIX `uid`/`gid` on local systems.
 * - Accepts either numbers or names; names are resolved using `/etc/passwd` and `/etc/group`.
 * - Returns `null` on Windows or when neither could be resolved.
 *
 * @internal
 */
async function toUidGid(
  owner?: string,
  group?: string,
  ctx?: { logger?: any }
): Promise<{ uid?: number; gid?: number } | null> {
  if (process.platform === "win32") {
    // Windows does not support POSIX chown meaningfully.
    return null
  }

  await loadEtcPasswd()
  await loadEtcGroup()

  const out: { uid?: number; gid?: number } = {}

  if (owner != null) {
    const maybeNum = Number(owner)
    if (Number.isInteger(maybeNum)) out.uid = maybeNum
    else if (passwdCache.has(owner)) out.uid = passwdCache.get(owner)!
    else
      ctx?.logger?.warn?.({
        msg: `copy(local): unknown owner '${owner}', skipping uid change`
      })
  }

  if (group != null) {
    const maybeNum = Number(group)
    if (Number.isInteger(maybeNum)) out.gid = maybeNum
    else if (groupCache.has(group)) out.gid = groupCache.get(group)!
    else
      ctx?.logger?.warn?.({
        msg: `copy(local): unknown group '${group}', skipping gid change`
      })
  }

  if (out.uid == null && out.gid == null) return null
  return out
}
