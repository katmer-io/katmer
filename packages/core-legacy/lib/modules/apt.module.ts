import { type ModuleConstraints } from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { SSHProvider } from "../providers/ssh/ssh.provider"
import type { OsInfo } from "../interfaces/provider.interface"
import { KatmerModule } from "../module"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      apt?: AptModuleOptions
    }
  }
}

/**
 * APT package manager: install, remove, and upgrade packages on Debian/Ubuntu.
 *
 * @remarks
 * - Uses `apt-get` with noninteractive, idempotent flags where possible.
 * - Can optionally refresh the cache (`apt-get update`) with retries/backoff.
 * - Supports installing from package names or local `.deb` files.
 * - When `upgrade` is set, a system-wide upgrade action runs before package
 *   state changes (e.g. `full-upgrade`), then requested package operations.
 *
 * @examples
 * ```yaml
 * # Refresh cache (if older than 10 minutes), install nginx, then autoremove
 * - name: Install nginx and clean up
 *   apt:
 *     name: nginx
 *     state: present
 *     update_cache: true
 *     cache_valid_time: 600
 *     autoremove: true
 *
 * # Ensure latest versions for a list of packages
 * - name: Bump packages to latest available versions
 *   apt:
 *     name: [curl, unzip, git]
 *     state: latest
 *
 * # Remove a package (purge configuration files too)
 * - name: Remove nginx completely
 *   apt:
 *     name: nginx
 *     state: absent
 *     purge: true
 *
 * # Install from local .deb(s)
 * - name: Install from local deb files
 *   apt:
 *     deb:
 *       - /tmp/custom_1.0.0_amd64.deb
 *       - /tmp/agent_2.3.1_amd64.deb
 *
 * # Run a safe upgrade first, then install a package
 * - name: Safe upgrade then install htop
 *   apt:
 *     upgrade: safe
 *     name: htop
 *     state: present
 * ```
 */
export class AptModule extends KatmerModule<
  AptModuleOptions,
  AptModuleResult,
  SSHProvider
> {
  constraints = {
    platform: {
      linux: {
        packages: ["apt"]
      }
    }
  } satisfies ModuleConstraints

  static name = "apt" as const

  private aptCmd = "apt-get"

  async check(ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    // tools
    const tools = ["apt-get", "dpkg", "apt-cache"]
    for (const t of tools) {
      const r = await ctx.exec(`command -v ${t} >/dev/null 2>&1; echo $?`)
      if (String(r.stdout).trim() !== "0") {
        throw new Error(`${t} is not available on the target system`)
      }
    }

    // resolve apt command preference
    this.aptCmd = this.params.force_apt_get ? "apt-get" : "apt-get"

    // basic validation
    if (
      this.params.state === "absent" &&
      !this.params.name &&
      !this.params.deb
    ) {
      throw new Error("state=absent requires 'name' or 'deb'")
    }
  }

  async initialize(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}
  async cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  private dpkgOptions(): string {
    const opts = new Set<string>(this.params.dpkg_options || [])
    if (this.params.dpkg_force_confnew) opts.add("--force-confnew")
    if (this.params.dpkg_force_confdef) opts.add("--force-confdef")
    if (opts.size === 0) return ""
    return Array.from(opts)
      .map((o) => `-o Dpkg::Options::=${quote(o)}`)
      .join(" ")
  }

  private installRecommends(): string {
    const v = this.params.install_recommends
    if (typeof v === "boolean") {
      return `-o APT::Install-Recommends=${v ? "true" : "false"}`
    }
    return "" // default apt behavior (true)
  }

  private lockTimeout(): string {
    const t = this.params.lock_timeout
    if (!t || t <= 0) return ""
    // best-effort; different apt versions handle this differently
    return `-o DPkg::Lock::Timeout=${t}`
  }

  private baseEnv(): string {
    const env: string[] = []
    if (typeof this.params.policy_rc_d === "number") {
      env.push(`POLICY_RC_D=${this.params.policy_rc_d}`)
    }
    if (this.params.allow_unauthenticated) {
      env.push("APT_LISTCHANGES_FRONTEND=none")
    }
    return env.join(" ")
  }

  private async aptUpdateIfNeeded(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<boolean> {
    const update_cache = !!this.params.update_cache
    if (!update_cache) return false

    // cache_valid_time best-effort: check mtime of lists dir
    const cv = this.params.cache_valid_time
    if (cv && cv > 0) {
      const stampCheck = await ctx.exec(
        "test -d /var/lib/apt/lists && stat -c %Y /var/lib/apt/lists 2>/dev/null || echo 0"
      )
      const stamp = Number(String(stampCheck.stdout).trim() || "0")
      if (stamp && nowSeconds() - stamp < cv) {
        return false
      }
    }

    const retries = this.params.update_cache_retries ?? 5
    const maxDelay = this.params.update_cache_retry_max_delay ?? 12
    const randomize = Math.random()
    const fatal = this.params.update_cache_error_fatal !== false

    for (let retry = 0; retry < retries; retry++) {
      const r = await ctx.exec(
        `${this.baseEnv()} sudo ${this.aptCmd} update -y`
      )
      if (r.code === 0) return true
      const lastErr = r.stderr || r.stdout || "unknown reason"
      ctx.warn(
        `apt-get update failed: ${lastErr}. Attempt ${retry + 1}/${retries}, retrying...`
      )
      let delay = 2 ** retry + randomize
      if (delay > maxDelay) delay = maxDelay + randomize
      await new Promise((res) => setTimeout(res, Math.round(delay * 1000)))
      if (retry === retries - 1 && fatal) {
        throw {
          changed: false,
          updated_cache: false,
          msg: `Failed to update apt cache after ${retries} retries: ${lastErr}`
        } as AptModuleResult
      }
    }
    return false
  }

  private aptCommonFlags(): string {
    const parts = [
      "-y",
      "-qq",
      this.lockTimeout(),
      this.dpkgOptions(),
      this.installRecommends(),
      this.params.only_upgrade ? "--only-upgrade" : "",
      this.params.allow_unauthenticated ? "--allow-unauthenticated" : ""
    ].filter(Boolean)
    return parts.join(" ")
  }

  private pkgListArg(): string {
    const pkgs = joinPkgs(this.params.name).filter(Boolean) as string[]
    return pkgs.map(quote).join(" ")
  }

  private debListArg(): string {
    const debs = joinPkgs(this.params.deb).filter(Boolean) as string[]
    return debs.map(quote).join(" ")
  }

  async execute(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<AptModuleResult> {
    const state: PackageState = this.params.state ?? "present"

    // update cache
    const updated_cache = await this.aptUpdateIfNeeded(ctx)

    // upgrades
    if (this.params.upgrade && this.params.upgrade !== "no") {
      const modeMap: Record<
        NonNullable<AptModuleOptions["upgrade"]>,
        string
      > = {
        no: "",
        yes: "upgrade",
        safe: "upgrade",
        full: "full-upgrade",
        dist: "dist-upgrade"
      }
      const sub = modeMap[this.params.upgrade]
      if (sub) {
        const cmd = `${this.baseEnv()} sudo ${this.aptCmd} ${sub} ${this.aptCommonFlags()}`
        const r = await ctx.exec(cmd)
        if (r.code !== 0) {
          throw {
            changed: false,
            updated_cache,
            upgraded: false,
            msg: r.stderr || r.stdout || `${this.aptCmd} ${sub} failed`
          } as AptModuleResult
        }
      }
    }

    let changed = false
    let stdout = ""
    let stderr = ""

    if (state === "present" || state === "latest" || state === "build-dep") {
      const verb = state === "build-dep" ? "build-dep" : "install"
      const pkgArgs = this.pkgListArg()
      const debArgs = this.debListArg()

      if (!pkgArgs && !debArgs) {
        // nothing to do
      } else {
        const extra = state === "latest" ? "--only-upgrade" : ""
        const targetArgs = debArgs || pkgArgs
        const cmd =
          `${this.baseEnv()} sudo ${this.aptCmd} ${verb} ${this.aptCommonFlags()} ${extra} ${targetArgs}`.trim()
        const r = await ctx.exec(cmd)
        stdout = r.stdout
        stderr = r.stderr
        if (r.code !== 0) {
          throw {
            changed: false,
            updated_cache,
            msg: r.stderr || r.stdout || `${this.aptCmd} ${verb} failed`
          } as AptModuleResult
        }
        changed = true
      }
    } else if (state === "absent") {
      const purge = this.params.purge ? "--purge" : ""
      const pkgArgs = this.pkgListArg()
      const debArgs = this.debListArg()
      const targetArgs = debArgs || pkgArgs
      if (targetArgs) {
        const cmd = `${this.baseEnv()} sudo ${this.aptCmd} remove ${purge} ${this.aptCommonFlags()} ${targetArgs}`
        const r = await ctx.exec(cmd)
        stdout = r.stdout
        stderr = r.stderr
        if (r.code !== 0) {
          throw {
            changed: false,
            updated_cache,
            msg: r.stderr || r.stdout || `${this.aptCmd} remove failed`
          } as AptModuleResult
        }
        changed = true
      }
    }

    // autoremove
    let didAutoremove = false
    if (this.params.autoremove) {
      const r = await ctx.exec(
        `${this.baseEnv()} sudo ${this.aptCmd} autoremove -y -qq ${this.lockTimeout()}`
      )
      if (r.code !== 0) {
        throw {
          changed,
          updated_cache,
          autoremove: false,
          msg: r.stderr || r.stdout || `${this.aptCmd} autoremove failed`
        } as AptModuleResult
      }
      didAutoremove = true
      changed = true
    }

    // clean
    let didClean = false
    if (this.params.clean) {
      const r = await ctx.exec(`${this.baseEnv()} sudo ${this.aptCmd} clean`)
      if (r.code !== 0) {
        throw {
          changed,
          updated_cache,
          cleaned: false,
          msg: r.stderr || r.stdout || `${this.aptCmd} clean failed`
        } as AptModuleResult
      }
      didClean = true
    }

    return {
      changed,
      stdout,
      stderr,
      updated_cache,
      upgraded: this.params.upgrade ? this.params.upgrade !== "no" : false,
      cleaned: didClean,
      autoremove: didAutoremove
    }
  }
}

type PackageState = "present" | "absent" | "latest" | "build-dep"
/**
 * Options for the **apt** module.
 */
export type AptModuleOptions = {
  /**
   * Name(s) of packages to manage.
   * Accepts a single name or a list.
   *
   * Ignored if only {@link AptModuleOptions.deb | deb} is provided.
   */
  name?: string | string[]

  /**
   * Desired package state.
   * - `present`: ensure installed (default).
   * - `absent`: ensure removed (optionally `purge` config files).
   * - `latest`: ensure installed at newest available version.
   * - `build-dep`: install build-dependencies for the named source package(s).
   * @defaultValue "present"
   */
  state?: "present" | "absent" | "latest" | "build-dep"

  /**
   * Run `apt-get update` before making changes.
   *
   * Honors {@link AptModuleOptions.cache_valid_time | cache_valid_time} to skip
   * the update if the package lists are fresh.
   */
  update_cache?: boolean

  /**
   * Perform a system-wide upgrade action before package operations.
   * - `no`: skip upgrade
   * - `yes`/`safe`: `apt-get upgrade`
   * - `full`: `apt-get full-upgrade`
   * - `dist`: `apt-get dist-upgrade`
   */
  upgrade?: "no" | "yes" | "safe" | "full" | "dist"

  /**
   * When removing (state=`absent`), purge configuration files as well.
   */
  purge?: boolean

  /**
   * After changes, remove automatically installed packages that are no longer needed.
   */
  autoremove?: boolean

  /**
   * Allow unauthenticated packages (passes `--allow-unauthenticated`).
   */
  allow_unauthenticated?: boolean

  /**
   * Convenience toggle for dpkg conflict handling (minimal set).
   * When `true`, acts like enabling `--force-confnew` for dpkg.
   * Prefer {@link AptModuleOptions.dpkg_options | dpkg_options} for full control.
   */
  force?: boolean

  /**
   * Raw dpkg options; each entry is passed as `-o Dpkg::Options::[value]`.
   *
   * Example: `["--force-confnew","--force-confdef"]`.
   *
   * See also the convenience flags:
   * {@link AptModuleOptions.dpkg_force_confnew | dpkg_force_confnew} and
   * {@link AptModuleOptions.dpkg_force_confdef | dpkg_force_confdef}.
   */
  dpkg_options?: string[]

  /**
   * Whether to install recommended packages.
   * Omitting keeps apt's default behavior (usually `true`).
   */
  install_recommends?: boolean

  /**
   * Max number of retry attempts for `apt-get update` when `update_cache` is enabled.
   * @defaultValue 5
   */
  update_cache_retries?: number

  /**
   * Maximum backoff delay (seconds) between update retries.
   * @defaultValue 12
   */
  update_cache_retry_max_delay?: number

  /**
   * Lock timeout for dpkg/apt operations (seconds).
   * Best-effort via `-o DPkg::Lock::Timeout=[seconds]`.
   */
  lock_timeout?: number

  /**
   * Set `POLICY_RC_D` in the environment (e.g. `101`) to prevent service starts.
   */
  policy_rc_d?: number

  /**
   * Upgrade only existing packages; do not install new ones.
   * Maps to `--only-upgrade` where applicable.
   */
  only_upgrade?: boolean

  /**
   * If set (seconds), skip `apt-get update` when the apt lists directory mtime
   * is newer than `now - cache_valid_time`. Best-effort heuristic.
   */
  cache_valid_time?: number

  /**
   * Local `.deb` path(s) to install directly. Accepts a single path or list.
   * If provided, {@link AptModuleOptions.name | name} is optional.
   */
  deb?: string | string[]

  /**
   * Prefer `apt-get` explicitly. (Kept for parity; module already uses `apt-get`.)
   */
  force_apt_get?: boolean

  /**
   * Run `apt-get clean` at the end.
   */
  clean?: boolean

  /**
   * Shorthand to add `--force-confnew` to dpkg options.
   * (Equivalent to including it in {@link AptModuleOptions.dpkg_options | dpkg_options}.)
   */
  dpkg_force_confnew?: boolean

  /**
   * Shorthand to add `--force-confdef` to dpkg options.
   * (Equivalent to including it in {@link AptModuleOptions.dpkg_options | dpkg_options}.)
   */
  dpkg_force_confdef?: boolean

  /**
   * If `true`, fail the task when `apt-get update` ultimately fails after retries.
   * @defaultValue true
   */
  update_cache_error_fatal?: boolean
}

/**
 * Result returned by the **apt** module.
 */
export type AptModuleResult = {
  /**
   * Whether any changes were made (install/remove/upgrade/autoremove/clean).
   */
  changed: boolean

  /**
   * Standard output from the last apt/dpkg command executed (best-effort).
   */
  stdout?: string

  /**
   * Standard error from the last apt/dpkg command executed (best-effort).
   */
  stderr?: string

  /**
   * Whether the package cache was updated during this run.
   */
  updated_cache?: boolean

  /**
   * Whether an upgrade action (per {@link AptModuleOptions.upgrade}) ran.
   */
  upgraded?: boolean

  /**
   * Whether `apt-get clean` ran.
   */
  cleaned?: boolean

  /**
   * Whether `apt-get autoremove` ran.
   */
  autoremove?: boolean

  /**
   * Human-readable message when the module surfaces an error condition.
   */
  msg?: string
}

function quote(v: string) {
  return JSON.stringify(v)
}

function joinPkgs(pkgs?: string | string[]): string[] {
  if (!pkgs) return []
  return Array.isArray(pkgs) ? pkgs : [pkgs]
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
