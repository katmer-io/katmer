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
      hostname?: HostnameModuleOptions
    }
  }
}

/**
 * Get or set the system hostname.
 *
 * @remarks
 * - When no options are provided, the module gathers the current hostname facts and returns them as JSON.
 * - When "name" is provided, the module sets the transient hostname (runtime) and optionally persists it to the appropriate config
 *   (e.g., /etc/hostname for most Linux distros or hostnamectl if available).
 * - The module attempts to be idempotent: if the current hostname already matches the desired one, changed=false.
 *
 * @examples
 * ```yaml
 * - name: Get hostname facts
 *   hostname: {}
 *
 * - name: Set runtime hostname only
 *   hostname:
 *     name: "app-node-01"
 *
 * - name: Set and persist hostname
 *   hostname:
 *     name: "app-node-01"
 *     persist: true
 * ```
 */
export class HostnameModule extends KatmerModule<
  HostnameModuleOptions,
  HostnameModuleResult,
  SSHProvider
> {
  static name = "hostname" as const

  constraints = {
    platform: {
      linux: true,
      darwin: true,
      windows: true
    }
  } satisfies ModuleConstraints

  async check(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async initialize(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async execute(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<HostnameModuleResult> {
    const { name, persist = false } = this.params

    const osfam = ctx.provider.os.family
    const run = async (cmd: string) => {
      const r = await ctx.exec(cmd)
      if (r.code !== 0) throw r
      return r.stdout.trim()
    }

    // Gather current facts (single roundtrip)
    const factsCmd = `
cur_short="$(hostname -s 2>/dev/null || true)"
cur_fqdn="$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)"
cur_domain=""
# Derive domain from FQDN when possible
case "$cur_fqdn" in
  *.*) cur_domain="\${cur_fqdn#*.}";;
  *) cur_domain="";;
esac
printf '{"short":"%s","fqdn":"%s","domain":"%s"}' "$cur_short" "$cur_fqdn" "$cur_domain"
`.trim()

    let changed = false
    let current: HostnameFacts
    try {
      const out = await run(factsCmd)
      current = JSON.parse(out) as HostnameFacts
    } catch (e: any) {
      // Fallback best-effort parse
      const curShort = await run("hostname -s 2>/dev/null || true")
      const curFqdn =
        (await ctx.exec("hostname -f 2>/dev/null")).stdout.trim() ||
        (await run("hostname 2>/dev/null || true"))
      const curDomain =
        curFqdn.includes(".") ? curFqdn.split(".").slice(1).join(".") : ""
      current = { short: curShort, fqdn: curFqdn, domain: curDomain }
    }

    if (!name) {
      // Read-only
      return {
        changed: false,
        facts: current,
        stdout: JSON.stringify(current)
      }
    }

    // Set runtime hostname if needed
    if (name !== current.short && name !== current.fqdn) {
      // Prefer hostnamectl when available; otherwise use hostname command
      const hasHostnamectl =
        (
          await ctx.exec("command -v hostnamectl >/dev/null 2>&1; echo $?")
        ).stdout.trim() === "0"
      const cmd =
        hasHostnamectl ?
          `hostnamectl set-hostname ${JSON.stringify(name)}`
        : `hostname ${JSON.stringify(name)}`
      const r = await ctx.exec(cmd)
      if (r.code !== 0) {
        throw {
          changed: false,
          msg: r.stderr || r.stdout || "failed to set hostname"
        } satisfies HostnameModuleResult
      }
      changed = true
    }

    // Persist if requested (best-effort, Linux-focused)
    if (persist) {
      // If hostnamectl exists, it usually persists. Still ensure /etc/hostname matches for classic systems.
      const etcHostname = "/etc/hostname"
      const check = await ctx.exec(
        `test -w ${JSON.stringify(etcHostname)}; echo $?`
      )
      if (check.stdout.trim() === "0") {
        // Avoid extra change if content already matches
        const read = await ctx.exec(
          `cat ${JSON.stringify(etcHostname)} 2>/dev/null || echo ""`
        )
        if (read.stdout.trim() !== name.trim()) {
          const write = await ctx.exec(
            `printf %s ${JSON.stringify(name.trim())} > ${JSON.stringify(etcHostname)}`
          )
          if (write.code !== 0) {
            throw {
              changed,
              msg: write.stderr || write.stdout || "failed to persist hostname"
            } satisfies HostnameModuleResult
          }
          changed = true
        }
      }
    }

    // Re-gather to return final state
    const finalOut = await run(factsCmd)
    const facts = JSON.parse(finalOut) as HostnameFacts

    return {
      changed,
      facts,
      stdout: JSON.stringify(facts)
    }
  }
}

/**
 * Options for hostname module.
 * @public
 */
export interface HostnameModuleOptions {
  /**
   * Desired hostname. If omitted, module only gathers current hostname facts.
   */
  name?: string
  /**
   * Whether to persist the hostname to system config (e.g., /etc/hostname).
   * @defaultValue false
   */
  persist?: boolean
}

/**
 * Hostname facts returned by the module.
 * @public
 */
export interface HostnameFacts {
  /**
   * Short host name (without domain).
   */
  short: string
  /**
   * Fully-qualified domain name if resolvable, otherwise the plain hostname.
   */
  fqdn: string
  /**
   * Derived domain part from FQDN (empty if not applicable).
   */
  domain: string
}

/**
 * Result of hostname module execution.
 * @public
 */
export interface HostnameModuleResult extends ModuleCommonReturn {
  facts?: HostnameFacts
}
