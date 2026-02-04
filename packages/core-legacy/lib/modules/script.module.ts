import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import { evalTemplate } from "../utils/renderer/renderer"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { KatmerModule } from "../module"

/**
 * Execute an ad-hoc shell script on the target.
 *
 * @remarks
 * - Accepts either a **string** (backwards compatible) or an **object** with a `content` string
 *   and a `render` flag to enable/disable template rendering.
 * - When `render` is `true` (default), the script string is rendered with Twig against context
 *   before execution. When `false`, the string is executed **as-is**.
 * - Uses the provider's shell via {@link Katmer.TaskContext.exec | `ctx.exec`}.
 * - Return semantics are simple: `changed` is always `false`; `failed` is set when the exit code is non-zero.
 * - Standard output and error are surfaced as `stdout` and `stderr`.
 *
 * @examples
 * ```yaml
 * - name: Simple one-liner (rendering enabled by default):
 *   script: "echo Hello {{ env | default('world') }}"
 *
 * - name: Multi-line script (rendering enabled by default):
 *   script: |
 *     set -euo pipefail
 *     echo "cwd={{ cwd }}"
 *     ls -la
 *
 * - name: Disable templating (execute exactly the given text):
 *   script:
 *     content: "echo {{ literally-not-rendered }}"
 *     render: false
 *
 * - name: Conditional logic - restart service in prod
 *   when: env == 'prod'
 *   script: "systemctl restart myapp || true"
 * ```
 */
export class ScriptModule extends KatmerModule<
  ScriptModuleOptions,
  ScriptModuleResult,
  KatmerProvider
> {
  static name = "script" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  async check(_ctx: Katmer.TaskContext): Promise<void> {
    const o = normalizeOptions(this.params)
    if (!o.content || typeof o.content !== "string") {
      throw new Error("script: 'content' must be a non-empty string")
    }
  }

  async initialize(_ctx: Katmer.TaskContext): Promise<void> {}
  async cleanup(_ctx: Katmer.TaskContext): Promise<void> {}

  async execute(ctx: Katmer.TaskContext): Promise<ScriptModuleResult> {
    const { content, render } = normalizeOptions(this.params)

    const scriptText =
      render ? await evalTemplate(content, ctx.variables) : content
    const r = await ctx.exec(scriptText)

    return {
      failed: r.code !== undefined && r.code !== 0,
      changed: false,
      stdout: r.stdout,
      stderr: r.stderr
    }
  }
}

/**
 * You can pass a **raw string** which will be rendered using template engine,
 * or an **object** to control rendering explicitly.
 *
 * @public
 */
export type ScriptModuleOptions =
  | string
  | {
      /** Inline script content to execute. */
      content: string
      /**
       * Whether to render the script with Twig against context before execution.
       * @defaultValue true
       */
      render?: boolean
    }

/**
 * Result of the script execution.
 *
 * @public
 */
export interface ScriptModuleResult extends ModuleCommonReturn {
  // inherits: changed, failed?, skipped?, msg?, stdout?, stderr?
}

// ────────────────────────────────────────────────────────────────────────────────
// internals
// ────────────────────────────────────────────────────────────────────────────────

function normalizeOptions(p: ScriptModuleOptions): {
  content: string
  render: boolean
} {
  if (typeof p === "string") return { content: p, render: true }
  const content = p?.content ?? ""
  const render = p?.render ?? true
  return { content, render }
}
