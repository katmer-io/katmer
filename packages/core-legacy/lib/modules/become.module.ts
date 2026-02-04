import { type ModuleConstraints } from "../interfaces/module.interface"
import type { SSHProvider } from "../providers/ssh/ssh.provider"
import type { Katmer } from "../interfaces/task.interface"
import { KatmerModule } from "../module"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      become?: BecomeModuleOptions
    }
  }
}
/**
 * When `true`, enable sudo with defaults.
 * When `false`, disable privilege escalation (no-op).
 * Or provide an object to customize user/prompt/password.
 */
export type BecomeModuleOptions =
  | boolean
  | {
      /**
       * Target user to run commands as (e.g. "root" or "deploy").
       */
      user?: string
      /**
       * Password for sudo (falls back to provider's password if omitted).
       */
      password?: string
      /**
       *  Prompt marker for sudo; used to detect when to send the password.
       */
      prompt?: string
    }

/**
 * Control privilege escalation.
 *
 * @remarks
 * - Set to `true` to enable sudo with sensible defaults (uses the provider's password if available).
 * - Set to `false` to disable privilege escalation (no-op).
 * - Provide an object to override sudo behavior (`user`, `password`, `prompt`).
 * - The module rewrites subsequent commands to `sudo -S -p [prompt] [-u <user>] ...`
 *   and automatically responds to the prompt with the configured password.
 *
 * @examples
 * ```yaml
 * # Enable with defaults (use provider password, run as root)
 * - name: Run with sudo
 *   become: true
 *
 * # Custom sudo user and prompt
 * - name: Run as deploy user with custom prompt
 *   become:
 *     user: deploy
 *     prompt: "SUDO:"
 *
 * # Explicit password override (falls back to provider password if omitted)
 * - name: Use an explicit sudo password
 *   become:
 *     user: root
 *     password: "{{ VAULT_SUDO_PASSWORD }}"
 *
 * # Disable privilege escalation
 * - name: Run without sudo
 *   become: false
 * ```
 */
export class BecomeModule extends KatmerModule<
  BecomeModuleOptions,
  {},
  SSHProvider
> {
  static internal = true

  static name = "become" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  async check(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  async initialize(ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    if (this.params === false) return

    const opts = Object.assign(
      {
        prompt: "KATMER_SUDO_PROMPT:",
        user: "",
        password: (ctx.provider as any).options?.password
      },
      this.params === true ? {} : this.params
    )
    const promptMarker = opts.prompt ?? "KATMER_SUDO_PROMPT:"
    const interactivePassword =
      opts.password ?? (ctx.provider as any).options?.password ?? ""
    const userPart = opts.user ? ` -u ${opts.user}` : ""

    // Supply rewrite + prompt handling hints for downstream exec()
    const rewriteCommand = (prepared: string) => {
      return `sudo -S -p '${promptMarker}'${userPart} ${prepared}`
    }

    ctx.exec = ctx.provider.executor({
      rewriteCommand,
      promptMarker: promptMarker,
      interactivePassword: interactivePassword,
      hidePromptLine: true
    })
  }

  async execute(_ctx: Katmer.TaskContext<SSHProvider>) {
    return { changed: false }
  }

  async cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}
}
