import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { SSHProvider } from "../providers/ssh/ssh.provider"
import { KatmerModule } from "../module"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      cron?: CronModuleOptions
    }
  }
}
/**
 * Manage scheduled jobs cross-platform.
 *
 * @remarks
 * - **POSIX (Linux/macOS/BSD)**: edits the per-user crontab using `crontab -l/-`.
 * - **Windows**: manages a Scheduled Task using `schtasks`.
 * - Idempotent by tracking named blocks (`# KATMER_CRON_START:<name>` / `# KATMER_CRON_END:<name>`) on POSIX.
 * - Supports adding/updating/removing a single job (by `name`) or clearing all jobs with `state: "absent"` and no `name` (dangerous).
 *
 * @examples
 * ```yaml
 * - name: Add Nightly backup (POSIX)
 *   cron:
 *     name: "nightly-backup"
 *     minute: "0"
 *     hour: "3"
 *     job: "/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1"
 *     user: "root"
 *
 * - name: Remove nightly backup (POSIX)
 *   cron:
 *     name: "nightly-backup"
 *     state: absent
 *     user: "root"
 *
 * - name: Re-index daily (Windows)
 *   cron:
 *     name: "reindex"
 *     job: "C:\\Program Files\\MyApp\\reindex.exe"
 *     at: "02:00"
 *     frequency: DAILY
 * ```
 *
 * @public
 */
export class CronModule extends KatmerModule<
  CronModuleOptions,
  CronModuleResult,
  SSHProvider
> {
  // Cross-platform: allow all, with a Linux package hint for cron; Windows supported.
  constraints = {
    platform: {
      linux: {
        binaries: [{ cmd: "sh" }], // sanity
        packages: [
          {
            // any of these ok, with minimal version
            name: "cron",
            range: ">=3.0",
            alternatives: [
              { name: "cronie", range: ">=1.5" },
              { name: "dcron", range: ">=4.5" }
            ]
          }
        ],
        distro: {
          alpine: { packages: [{ name: "dcron", range: ">=4.5" }] },
          arch: { packages: [{ name: "cronie", range: ">=1.6" }] }
        }
      },
      darwin: {
        // we use crontab; optionally require it:
        binaries: [{ cmd: "crontab" }]
      },
      windows: {
        // uses schtasks; ensure PowerShell exists & version:
        binaries: [
          { cmd: "powershell", versionRegex: /([\d.]+)/, range: ">=5.1" }
        ]
      }
    }
  } satisfies ModuleConstraints

  static name = "cron" as const

  async check(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    const p = this.params || ({} as CronModuleOptions)
    if (p.state !== "absent" && (!p.name || !p.job)) {
      throw new Error("'name' and 'job' are required when state != absent")
    }
  }

  async initialize(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}
  async cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async execute(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<CronModuleResult> {
    const osfam = ctx.provider.os.family

    if (osfam === "windows") {
      return await this.executeWindows(ctx)
    }

    // Default POSIX path (Linux, macOS, BSD, etc.) via crontab
    return await this.executePosixCron(ctx)
  }

  /**
   * POSIX implementation using per-user `crontab`.
   *
   * @remarks
   * - If `name` is provided, the job is wrapped by start/end markers for safe updates/removal.
   * - If `state: "absent"` and no `name`, will clear **all** crontab entries for the target user.
   * - Uses a temp file + `crontab <file>` to write idempotently.
   *
   * @param ctx - Katmer task context
   * @returns Result with `changed` and a simple message
   * @throws When reading/writing the crontab fails
   * @internal
   */
  private async executePosixCron(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<CronModuleResult> {
    const {
      name,
      job,
      user,
      state = "present",
      special_time,
      minute = "*",
      hour = "*",
      day = "*",
      month = "*",
      weekday = "*",
      disabled = false,
      env,
      backup = false
    } = this.params

    const runAs = user ? `sudo -u ${q(user)} ` : ""
    const markerStart = name ? `# KATMER_CRON_START:${name}` : ""
    const markerEnd = name ? `# KATMER_CRON_END:${name}` : ""
    const header = name ? [markerStart] : []
    const footer = name ? [markerEnd] : []

    // Read current crontab for user
    const getCmd = `${runAs}crontab -l 2>/dev/null || true`
    const current = await ctx.exec(getCmd)
    if (current.code !== 0) {
      throw {
        changed: false,
        msg: current.stderr || "failed to read crontab"
      } satisfies CronModuleResult
    }
    const originalCrontab = (current.stdout || "").replace(/\r/g, "")
    let lines = splitLines(originalCrontab)

    // Backup if asked
    if (backup && originalCrontab.trim()) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-")
      await ctx.exec(
        `${runAs}crontab -l > ${q(
          `/tmp/crontab-${user || "root"}-${ts}.bak`
        )} 2>/dev/null || true`
      )
    }

    // Remove existing block for this name (if tracked)
    if (name) {
      lines = stripBlock(lines, markerStart, markerEnd)
    }

    let changed = false

    if (state === "absent") {
      // If name provided, removal already done by stripBlock; detect change
      if (name) {
        changed = originalCrontab !== lines.join("\n")
      } else {
        // Dangerous: clear all
        if (originalCrontab.trim().length > 0) {
          lines = []
          changed = true
        }
      }
    } else {
      // Build entry lines
      const entryLines: string[] = []

      // environment variables section (optional)
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          entryLines.push(`${k}=${formatEnvValue(v)}`)
        }
      }

      // job line
      const cronLine =
        special_time ?
          `${disabled ? "# " : ""}${special("@", special_time)} ${job}`
        : `${disabled ? "# " : ""}${minute} ${hour} ${day} ${month} ${weekday} ${job}`

      if (name) entryLines.unshift(...header)
      entryLines.push(cronLine)
      if (name) entryLines.push(...footer)

      // Append a separator newline between blocks when needed
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("")
      lines.push(...entryLines)

      // Detect change
      changed = originalCrontab !== lines.join("\n")
    }

    if (changed) {
      // Write back
      // Ensure final ends with newline
      let finalBody = lines.join("\n")
      if (!finalBody.endsWith("\n")) finalBody += "\n"

      const tmp = `/tmp/katmer-cron-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.tmp`
      const writeTmp = await ctx.exec(`cat > ${q(tmp)} << "KATMER_EOF"
${finalBody}
KATMER_EOF`)
      if (writeTmp.code !== 0) {
        await ctx.exec(`rm -f ${q(tmp)}`).catch(() => {})
        throw {
          changed: false,
          msg:
            writeTmp.stderr || writeTmp.stdout || "failed to stage new crontab"
        } satisfies CronModuleResult
      }

      const load = await ctx.exec(`${runAs}crontab ${q(tmp)}`)
      await ctx.exec(`rm -f ${q(tmp)}`).catch(() => {})
      if (load.code !== 0) {
        throw {
          changed: false,
          msg: load.stderr || load.stdout || "failed to install new crontab"
        } satisfies CronModuleResult
      }
    }

    return {
      changed,
      stdout: changed ? "crontab updated" : "no change",
      stderr: ""
    }
  }

  // ---------- Windows (schtasks) ----------

  /**
   * Windows implementation using `schtasks`.
   *
   * @remarks
   * - Creates or updates a named task (`name`) to run the provided command (`job`).
   * - Uses `at` (HH:mm) and `frequency` when provided; otherwise, attempts to derive time from POSIX `minute`/`hour`.
   * - On schedule change where `/Change` is insufficient, we delete and recreate the task for idempotency.
   *
   * @param ctx - Katmer task context
   * @returns Result with `changed` and the raw CLI output on failure
   * @internal
   */
  private async executeWindows(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<CronModuleResult> {
    const {
      name,
      job,
      state = "present",
      user,
      at,
      frequency
    } = this.params as CronModuleOptions & {
      at?: string
      frequency?: WindowsFrequency
    }

    if (!name || !job) {
      return {
        changed: false,
        failed: true,
        msg: "windows: 'name' and 'job' are required"
      }
    }

    // Try to derive /ST from cron fields if not provided
    const st =
      at && isValidHHMM(at) ? at : (
        deriveHHMMFromCron(this.params.minute, this.params.hour) || "12:00"
      )

    const sc: WindowsFrequency = frequency || "DAILY"

    const jsonQ = (s: string) => JSON.stringify(s)
    const tn = jsonQ(name)

    if (state === "absent") {
      const del = await ctx.exec(`schtasks /Delete /TN ${tn} /F`)
      const ok = del.code === 0
      return {
        changed: ok,
        failed: false,
        msg: ok ? "deleted" : del.stderr || del.stdout
      }
    }

    // Create (or replace if exists)
    const createCmd = [
      `schtasks /Create /TN ${tn}`,
      `/TR ${jsonQ(job)}`,
      `/SC ${sc}`,
      `/ST ${jsonQ(st)}`,
      user ? `/RU ${jsonQ(user)}` : ""
    ]
      .filter(Boolean)
      .join(" ")

    let r = await ctx.exec(createCmd)

    if (r.code !== 0) {
      // If exists, delete and recreate to be idempotent across schedule changes
      if (/already exists/i.test(r.stderr || r.stdout || "")) {
        const del = await ctx.exec(`schtasks /Delete /TN ${tn} /F`)
        if (del.code === 0) {
          r = await ctx.exec(createCmd)
        } else {
          r = del
        }
      }
    }

    const ok = r.code === 0
    return { changed: ok, failed: !ok, msg: r.stderr || r.stdout }
  }
}

/**
 * Options for cron module (cross-platform).
 * On Windows, you may optionally use `at` (HH:mm) and `frequency`.
 */
export interface CronModuleOptions {
  /**
   * Unique job identifier.
   * - POSIX: used to mark/update the block in crontab.
   * - Windows: used as the Scheduled Task name.
   */
  name?: string

  /**
   * Command to execute.
   * - Required when `state: "present"`.
   */
  job?: string

  /**
   * Target user whose crontab/task is managed.
   * - POSIX: affects which user's crontab is edited (via `sudo -u`).
   * - Windows: used as `/RU` when provided.
   */
  user?: string

  /**
   * Desired presence.
   * @defaultValue "present"
   */
  state?: "present" | "absent"

  // -------- POSIX cron fields --------

  /**
   * One of: `yearly`, `annually`, `monthly`, `weekly`, `daily`, `hourly`, `reboot`.
   * Mutually exclusive with `minute/hour/day/month/weekday`.
   */
  special_time?:
    | "reboot"
    | "yearly"
    | "annually"
    | "monthly"
    | "weekly"
    | "daily"
    | "hourly"

  /** Cron minute field. Ignored when `special_time` is set. */
  minute?: string
  /** Cron hour field. Ignored when `special_time` is set. */
  hour?: string
  /** Cron day-of-month field. Ignored when `special_time` is set. */
  day?: string
  /** Cron month field. Ignored when `special_time` is set. */
  month?: string
  /** Cron day-of-week field. Ignored when `special_time` is set. */
  weekday?: string

  /**
   * Comment out (disable) the job but keep it in crontab (POSIX).
   * @defaultValue false
   */
  disabled?: boolean

  /**
   * Environment variables to prepend to the job block (POSIX).
   * @example `{ PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin", MAILTO: "ops@example.com" }`
   */
  env?: Record<string, string | number | boolean>

  /**
   * If `true`, saves the existing crontab to `/tmp` before modifying (POSIX).
   * @defaultValue false
   */
  backup?: boolean

  // -------- Windows convenience --------

  /**
   * Time for `schtasks` in 24-hour `HH:mm` format.
   * If omitted, it is derived from `minute`/`hour` when both are numeric.
   */
  at?: string

  /**
   * `schtasks` frequency.
   * @defaultValue "DAILY"
   */
  frequency?: WindowsFrequency
}

/**
 * Allowed values for the Windows `schtasks /SC` option.
 * @public
 */
export type WindowsFrequency =
  | "MINUTE"
  | "HOURLY"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY"
  | "ONCE"

/**
 * Result for {@link CronModule}.
 * @public
 */
export interface CronModuleResult extends ModuleCommonReturn {}

/* -------------------- helpers -------------------- */

/**
 * JSON-quotes a string for shell-safe heredoc usage.
 * @internal
 */
function q(s: string) {
  return JSON.stringify(s)
}

/**
 * Split a multi-line string into lines (normalizing CRLF).
 * @internal
 */
function splitLines(s: string): string[] {
  return (s || "").replace(/\r/g, "").split("\n")
}

/**
 * Remove an inclusive block between exact `start` and `end` marker lines.
 * @internal
 */
function stripBlock(lines: string[], start: string, end: string): string[] {
  if (!start || !end) return lines
  const out: string[] = []
  let skip = false
  for (const line of lines) {
    if (!skip && line.trim() === start) {
      skip = true
      continue
    }
    if (skip && line.trim() === end) {
      skip = false
      continue
    }
    if (!skip) out.push(line)
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop()
  return out
}

/**
 * Format a `@special` token or return `""` if not set.
 * @internal
 */
function special(prefix: "@" | "", t?: CronModuleOptions["special_time"]) {
  if (!t) return ""
  return `${prefix}${t}`
}

/**
 * Render an env value for POSIX crontab (quote if needed).
 * @internal
 */
function formatEnvValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return String(v)
  // Quote if contains spaces or special chars
  return /[\s"'`$\\]/.test(v) ? JSON.stringify(v) : v
}

/**
 * Derive `HH:mm` when both `minute` & `hour` are exact integers.
 * @internal
 */
function deriveHHMMFromCron(
  minute?: string,
  hour?: string
): string | undefined {
  if (!minute || !hour) return undefined
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return undefined
  const mi = parseInt(minute, 10)
  const hr = parseInt(hour, 10)
  if (mi < 0 || mi > 59 || hr < 0 || hr > 23) return undefined
  return pad2(hr) + ":" + pad2(mi)
}

/** @internal */
function pad2(n: number) {
  return n < 10 ? "0" + n : String(n)
}

/** @internal */
function isValidHHMM(s: string): boolean {
  return /^([0-1]\d|2[0-3]):[0-5]\d$/.test(s)
}
