import type { Katmer } from "../../interfaces/task.interface"
import { SourcesList } from "./apt-sources-list"
import { cloneInstance } from "../../utils/object.utils"
import type { SSHProvider } from "../../providers/ssh/ssh.provider"
import { KatmerModule } from "../../module"

declare module "../../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      /**
       * Manage apt repositories (.list files).
       * See {@link AptRepositoryModuleOptions | AptRepositoryModuleOptions} for all parameters.
       */
      apt_repository?: AptRepositoryModuleOptions
    }
  }
}
export interface AptRepositoryModuleOptions {
  /**
   * Desired end-state for the repository line(s).
   *
   * - `"present"`: ensure the given `repo` line(s) exist (create/update files as needed).
   * - `"absent"`: remove matching lines (by exact `repo` or by `regexp`).
   *
   * @defaultValue "present"
   */
  state?: "present" | "absent"

  /**
   * Repository line(s) to add or remove.
   *
   * - **Required** when `state === "present"`.
   * - **Optional** when `state === "absent"`; you may use this to remove specific line(s), or omit it and use `regexp` to remove by pattern.
   */
  repo?: string | string[]

  /**
   * Regular expression to match lines for removal (used only with `state === "absent"`).
   *
   * @remarks
   * - Mutually exclusive with `repo` for `state === "present"`.
   * - Useful to sweep multiple entries across files (e.g., remove a discontinued mirror).
   *
   * @example
   * "^deb .*example\\.com"
   */
  regexp?: string

  /**
   * Override the destination filename (no path).
   *
   * @remarks
   * - When adding lines, places them under `/etc/apt/sources.list.d/[filename].list`.
   * - If omitted, the module chooses a suitable filename (e.g. derived from the repo).
   *
   * @example
   * "example.list"
   */
  filename?: string

  /**
   * Run `apt-get update` after changes.
   *
   * @remarks
   * - Only runs if any file content actually changed.
   * - Retries are controlled by {@link AptRepositoryModuleOptions.update_cache_retries} and {@link AptRepositoryModuleOptions.update_cache_retry_max_delay}.
   *
   * @defaultValue false
   */
  update_cache?: boolean

  /**
   * Maximum retry attempts when updating the APT cache.
   *
   * @defaultValue 5
   */
  update_cache_retries?: number

  /**
   * Maximum exponential backoff (seconds) between retries when updating the cache.
   *
   * @defaultValue 12
   */
  update_cache_retry_max_delay?: number

  /**
   * Validate TLS certificates when fetching remote keys/sources.
   *
   * @defaultValue true
   */
  validate_certs?: boolean

  /**
   * Simulate changes without writing files or running `apt-get update`.
   *
   * @remarks
   * - Returns what would change; useful in CI and dry runs.
   *
   * @defaultValue false
   */
  check_mode?: boolean

  /**
   * File mode for created/updated source files.
   *
   * @remarks
   * - Accepts octal number (e.g., `0o644`) or string (e.g., `"0644"`).
   * - Only applied to files the module creates/updates.
   *
   * @example
   * "0644"
   * @example
   * 0o644
   */
  mode?: number | string
}

/**
 * Result returned by the `apt-repository` module.
 * @public
 */
export interface AptRepositoryModuleResult {
  /** Original repo parameter (if provided). */
  repo?: string | string[]
  /** Filenames created. */
  sources_added: string[]
  /** Filenames removed. */
  sources_removed: string[]
}
/**
 * Manage entries in APT sources lists (e.g. `/etc/apt/sources.list.d/*.list`).
 *
 * @remarks
 * - When `state: "present"`, at least one `repo` line is required.
 * - When `state: "absent"`, you may remove by explicit `repo` line(s) or by `regexp`.
 * - For `state: "present"`, do **not** set `regexp` (mutually exclusive with `repo`).
 * - If `update_cache` is true and changes occurred, `apt-get update` will run with retries/backoff.
 *
 * @examples
 * ```yaml
 * - name: Add a repo line and refresh cache
 *   apt-repository:
 *     state: present
 *     repo: "deb http://deb.debian.org/debian bookworm main"
 *     update_cache: true
 *
 * - name: Remove specific repo lines
 *   apt-repository:
 *     state: absent
 *     repo:
 *       - "deb http://old.example.com/debian bookworm main"
 *       - "deb-src http://old.example.com/debian bookworm main"
 *
 * - name: Remove all lines that match a pattern
 *   apt-repository:
 *     state: absent
 *     regexp: "^deb .*example\\.com"
 *
 * - name: Add deb + deb-src into a fixed filename
 *   apt-repository:
 *     state: present
 *     filename: "example.list"
 *     repo:
 *       - "deb http://deb.debian.org/debian bookworm main"
 *       - "deb-src http://deb.debian.org/debian bookworm main"
 *     mode: "0644"
 * ```
 */

export class AptRepositoryModule extends KatmerModule<
  AptRepositoryModuleOptions,
  AptRepositoryModuleResult,
  SSHProvider
> {
  static name = "apt-repository" as const

  constraints = {
    platform: {
      linux: {
        packages: ["apt"]
      }
    }
  }
  apt_config!: Record<string, any>
  sources_list!: SourcesList

  async check(ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    if (this.params.state === "present" && (this.params as any).regexp) {
      throw "'regexp' is not supported with state: 'present'"
    }
    if ((this.params as any).regexp && (this.params as any).repo) {
      throw "'regexp' and 'repo' cannot be used together"
    }

    const checkModules = ["apt-get", "apt-config"]
    for (const module of checkModules) {
      const checkResult = await ctx.execSafe(
        `command -v ${module} >/dev/null 2>&1; echo $?`
      )
      if (String(checkResult.stdout).trim() !== "0") {
        throw new Error(`${module} is not available on the target system.`)
      }
    }

    const { stdout } = await ctx.exec("apt-config dump")
    this.apt_config = parseAPTConfig(stdout)

    // validate repo lines only for "present"
    const state = this.params.state ?? "present"
    if (state === "present") {
      const repo = this.params.repo
      const repos = Array.isArray(repo) ? repo : [repo]
      const first = repos.find((r) => typeof r === "string" && r.trim())
      if (!first) {
        throw new Error(
          "Invalid configuration: 'repo' must be a non-empty string or string[]"
        )
      }
      const firstToken = first
        .replace(/\[[^\]]*\]/g, "")
        .trim()
        .split(/\s+/)[0]
      if (!/^deb(-src)?$/.test(firstToken)) {
        throw new Error("Repository line must start with 'deb' or 'deb-src'")
      }
    }
  }

  async initialize(ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    this.sources_list = new SourcesList(this.apt_config, ctx)
    await this.sources_list.init()
  }

  cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    return Promise.resolve(undefined)
  }

  protected async _revert_sources_list(
    ctx: Katmer.TaskContext<SSHProvider>,
    sources_before: Record<string, string>,
    sources_after: Record<string, string>,
    initial_sources_list: SourcesList
  ) {
    try {
      const beforeKeys = new Set(Object.keys(sources_before))
      const afterKeys = new Set(Object.keys(sources_after))

      // remove files that didn't exist before
      for (const added of Object.keys(sources_after)) {
        if (!beforeKeys.has(added)) {
          await ctx.exec(`rm -f -- ${JSON.stringify(added)}`).catch(() => {})
        }
      }

      // restore only files that existed before AND whose contents actually changed
      for (const filename of Object.keys(sources_before)) {
        if (!afterKeys.has(filename)) continue
        const beforeContent = sources_before[filename] ?? ""
        const afterContent = sources_after[filename] ?? ""
        if (beforeContent !== afterContent) {
          const payload = beforeContent.replace(/'/g, `'\"'\"'`)
          const tmp = `${filename}.katmer-revert.$RANDOM$$`
          const writeCmd = `'umask 022; tmp=${JSON.stringify(tmp)}; target=${JSON.stringify(
            filename
          )}; printf %s '${payload}' > "$tmp" && mv -f "$tmp" "$target"`
          await ctx.exec(writeCmd).catch(() => {})
        }
      }
    } catch {
      // ignore revert failures
    } finally {
      await initial_sources_list.save()
    }
  }

  async execute(ctx: Katmer.TaskContext<SSHProvider>) {
    const state = this.params.state ?? "present"
    const update_cache = !!this.params.update_cache

    const sources_list = this.sources_list
    const initial_sources_list = cloneInstance(sources_list)
    const sources_before = sources_list.dump()

    try {
      if (state === "present") {
        const { repo, filename } = this.params
        const fname = filename?.trim() || undefined
        const repos = Array.isArray(repo) ? repo : [repo]
        for (const r of repos) {
          if (!r?.trim()) continue
          this.sources_list.add_source(r, "", fname)
        }
      } else {
        const { repo, regexp } = this.params
        const repos = Array.isArray(repo) ? repo : [repo]
        if (repos.length > 0) {
          for (const r of repos) {
            if (!r) continue
            sources_list.remove_source(r, undefined)
          }
        } else {
          // fallback to regexp removal when repo not provided
          sources_list.remove_source(undefined, regexp)
        }
      }
    } catch (ex: any) {
      throw new Error(`Invalid repository string: ${String(ex?.message ?? ex)}`)
    }

    const sources_after = sources_list.dump()
    const changed =
      JSON.stringify(sources_before) !== JSON.stringify(sources_after)

    let diff: Array<{
      before: string
      after: string
      before_header: string
      after_header: string
    }> = []
    let sources_added: string[] = []
    let sources_removed: string[] = []

    if (changed) {
      const beforeKeys = new Set(Object.keys(sources_before))
      const afterKeys = new Set(Object.keys(sources_after))

      sources_added = [...afterKeys].filter((k) => !beforeKeys.has(k))
      sources_removed = [...beforeKeys].filter((k) => !afterKeys.has(k))

      const union = new Set<string>([
        ...sources_added,
        ...sources_removed,
        ...Object.keys(sources_before).filter((k) => afterKeys.has(k))
      ])
      diff = [...union]
        .filter(
          (filename) =>
            (sources_before[filename] ?? "") !== (sources_after[filename] ?? "")
        )
        .map((filename) => ({
          before: sources_before[filename] ?? "",
          after: sources_after[filename] ?? "",
          before_header: sources_before[filename] ? filename : "/dev/null",
          after_header: sources_after[filename] ? filename : "/dev/null"
        }))
    }

    if (changed && !this.params.check_mode) {
      try {
        // save() will write only changed files and delete only those that became empty
        await sources_list.save()

        if (update_cache) {
          const retries = this.params.update_cache_retries ?? 5
          const maxDelay = this.params.update_cache_retry_max_delay ?? 12
          const randomize = Math.random()

          let success = false
          let lastErr = ""

          for (let retry = 0; retry < retries; retry++) {
            const r = await ctx.execSafe("sudo apt-get update -y")
            if (r.code === 0) {
              success = true
              break
            }
            lastErr = r.stderr || r.stdout || "unknown reason"
            ctx.warn(
              `Failed to update cache after ${retry + 1} due to ${lastErr} retry, retrying`
            )

            let delay = 2 ** retry + randomize
            if (delay > maxDelay) delay = maxDelay + randomize
            ctx.warn(
              `Sleeping for ${Math.round(delay)} seconds, before attempting to update the cache again`
            )
            await new Promise((res) =>
              setTimeout(res, Math.round(delay * 1000))
            )
          }

          if (!success) {
            ctx.fail(
              `Failed to update apt cache after ${retries} retries: ${lastErr}`
            )
          }
        }
      } catch (e) {
        await this._revert_sources_list(
          ctx,
          sources_before,
          sources_after,
          initial_sources_list
        )
        throw e
      }
    }

    return {
      changed,
      repo: (this.params as any).repo,
      state,
      sources_added,
      sources_removed,
      diff
    }
  }
}

function parseAPTConfig(raw: string) {
  const result: Record<string, string | string[]> = {}

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    const m = line.match(/^(.+?)\s+"?(.*?)"?;$/)
    if (!m) continue

    const rawKey = m[1].trim() // e.g., Dir::Etc::sourcelist
    const value = m[2]

    const current = result[rawKey]
    if (current === undefined) {
      result[rawKey] = value
    } else if (Array.isArray(current)) {
      current.push(value)
    } else {
      result[rawKey] = [current, value]
    }
  }
  return result
}
