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
      systemd_service?: SystemdServiceModuleOptions
    }
  }
}
/**
 * Manage systemd units (start/stop/restart/reload/enable/disable/mask/unmask/daemon-reload).
 *
 * @remarks
 * - Requires systemd on the target (systemctl must be available).
 * - Operations are idempotent where feasible by checking current unit state.
 *
 * @examples
 * ```yaml
 * - name: Start and enable a service
 *   systemd_service:
 *     name: nginx
 *     state: started
 *     enabled: true
 *
 * - name: Restart with daemon-reload
 *   systemd_service:
 *     name: myapp.service
 *     daemon_reload: true
 *     state: restarted
 *
 * - name: Stop and disable a timer
 *   systemd_service:
 *     name: myjob.timer
 *     state: stopped
 *     enabled: false
 * ```
 */
export class SystemdServiceModule extends KatmerModule<
  SystemdServiceModuleOptions,
  SystemdServiceModuleResult,
  SSHProvider
> {
  static name = "systemd_service" as const

  constraints = {
    platform: {
      linux: {
        requireRoot: true, // system scope typically needs root
        binaries: [
          // Parse "systemd 245 (...)" from `systemctl --version`
          {
            cmd: "systemctl",
            args: ["--version"],
            versionRegex: /systemd\s+(\d+)/,
            range: ">=219"
          }
        ],
        // Shorthand strings are normalized to { name, range }
        packages: ["systemd@>=219"],
        // Turn off known non-systemd distro
        distro: {
          alpine: false
        }
      }
    }
  } satisfies ModuleConstraints

  async check(ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    const { stdout } = await ctx.exec(
      `command -v systemctl >/dev/null 2>&1; echo $?`
    )
    if (stdout.trim() !== "0") {
      throw new Error(
        "systemctl not found; target does not appear to be using systemd"
      )
    }
    if (!this.params?.name || !String(this.params.name).trim()) {
      throw new Error("'name' is required (unit name, e.g., nginx.service)")
    }
  }

  async initialize(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async execute(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<SystemdServiceModuleResult> {
    const {
      name,
      state,
      enabled,
      masked,
      daemon_reload,
      scope = "system", // or "user"
      no_block = false
    } = this.params

    const unit = String(name).trim()
    const scopeFlag = scope === "user" ? "--user" : ""

    // helper
    const ok = async (cmd: string) => {
      const r = await ctx.exec(cmd)
      return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() }
    }

    // daemon-reload first (commonly desired before actions)
    let changed = false
    if (daemon_reload) {
      const r = await ok(`systemctl ${scopeFlag} daemon-reload`)
      if (r.code !== 0) {
        throw {
          changed,
          msg: r.err || r.out || "daemon-reload failed"
        } as SystemdServiceModuleResult
      }
      changed = true
    }

    // Query current status/idempotency anchors
    const isActive = await this.getIsActive(ctx, unit, scopeFlag)
    const isEnabled = await this.getIsEnabled(ctx, unit, scopeFlag)
    const isMasked = await this.getIsMasked(ctx, unit, scopeFlag)

    // mask/unmask if requested explicitly
    if (typeof masked === "boolean") {
      if (masked && !isMasked) {
        const r = await ok(
          `systemctl ${scopeFlag} mask ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "mask failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      } else if (!masked && isMasked) {
        const r = await ok(
          `systemctl ${scopeFlag} unmask ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "unmask failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      }
    }

    // enable/disable if requested
    if (typeof enabled === "boolean") {
      if (enabled && !isEnabled) {
        const r = await ok(
          `systemctl ${scopeFlag} enable ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "enable failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      } else if (!enabled && isEnabled) {
        const r = await ok(
          `systemctl ${scopeFlag} disable ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "disable failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      }
    }

    // state transitions
    if (state) {
      if (state === "started" && !isActive) {
        const r = await ok(
          `systemctl ${scopeFlag} start ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "start failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      } else if (state === "stopped" && isActive) {
        const r = await ok(
          `systemctl ${scopeFlag} stop ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "stop failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      } else if (state === "restarted") {
        const r = await ok(
          `systemctl ${scopeFlag} restart ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "restart failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      } else if (state === "reloaded") {
        const r = await ok(
          `systemctl ${scopeFlag} reload ${this.blockFlag(no_block)} ${q(unit)}`
        )
        if (r.code !== 0) {
          throw {
            changed,
            msg: r.err || r.out || "reload failed"
          } as SystemdServiceModuleResult
        }
        changed = true
      } else if (state === "paused" || state === "unpaused") {
        // No direct systemctl verb; map paused -> stop, unpaused -> start (best-effort)
        if (state === "paused" && isActive) {
          const r = await ok(
            `systemctl ${scopeFlag} stop ${this.blockFlag(no_block)} ${q(unit)}`
          )
          if (r.code !== 0) {
            throw {
              changed,
              msg: r.err || r.out || "pause(stop) failed"
            } as SystemdServiceModuleResult
          }
          changed = true
        }
        if (state === "unpaused" && !isActive) {
          const r = await ok(
            `systemctl ${scopeFlag} start ${this.blockFlag(no_block)} ${q(unit)}`
          )
          if (r.code !== 0) {
            throw {
              changed,
              msg: r.err || r.out || "unpause(start) failed"
            } as SystemdServiceModuleResult
          }
          changed = true
        }
      }
    }

    // Re-query for result
    const finalActive = await this.getIsActive(ctx, unit, scopeFlag)
    const finalEnabled = await this.getIsEnabled(ctx, unit, scopeFlag)
    const finalMasked = await this.getIsMasked(ctx, unit, scopeFlag)

    return {
      changed,
      status: {
        name: unit,
        active: finalActive,
        enabled: finalEnabled,
        masked: finalMasked,
        scope
      }
    }
  }

  private blockFlag(no_block?: boolean) {
    // systemctl is synchronous by default; when no_block is true, add --no-block
    return no_block ? "--no-block" : ""
  }

  private async getIsActive(
    ctx: Katmer.TaskContext<SSHProvider>,
    unit: string,
    scopeFlag: string
  ) {
    const r = await ctx.exec(
      `systemctl ${scopeFlag} is-active ${q(unit)} || true`
    )
    return r.stdout.trim() === "active"
  }
  private async getIsEnabled(
    ctx: Katmer.TaskContext<SSHProvider>,
    unit: string,
    scopeFlag: string
  ) {
    const r = await ctx.exec(
      `systemctl ${scopeFlag} is-enabled ${q(unit)} || true`
    )
    const s = r.stdout.trim()
    return s === "enabled" || s === "static" || s === "indirect"
  }
  private async getIsMasked(
    ctx: Katmer.TaskContext<SSHProvider>,
    unit: string,
    scopeFlag: string
  ) {
    const r = await ctx.exec(
      `systemctl ${scopeFlag} is-enabled ${q(unit)} || true`
    )
    return r.stdout.trim() === "masked"
  }
}

/**
 * Options for systemd_service module.
 * @public
 */
export interface SystemdServiceModuleOptions {
  /**
   * Unit name, e.g., "nginx.service" (".service" suffix optional).
   */
  name: string
  /**
   * Desired unit state.
   */
  state?:
    | "started"
    | "stopped"
    | "restarted"
    | "reloaded"
    | "paused"
    | "unpaused"
  /**
   * Enable or disable unit at boot.
   */
  enabled?: boolean
  /**
   * Mask or unmask the unit.
   */
  masked?: boolean
  /**
   * Run `systemctl daemon-reload` before actions.
   */
  daemon_reload?: boolean
  /**
   * Target scope (system/user). Default: system.
   */
  scope?: "system" | "user"
  /**
   * Use --no-block for start/stop/restart/reload/enable/disable/mask/unmask.
   */
  no_block?: boolean
}

/**
 * Result for systemd_service module.
 * @public
 */
export interface SystemdServiceModuleResult extends ModuleCommonReturn {
  status: {
    name: string
    active: boolean
    enabled: boolean
    masked: boolean
    scope: "system" | "user" | string
  }
}

function q(s: string) {
  return JSON.stringify(s)
}
