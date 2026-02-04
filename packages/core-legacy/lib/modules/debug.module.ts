// modules/debug.module.ts
import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { get } from "es-toolkit/compat"
import { evalTemplate } from "../utils/renderer/renderer"
import { wrapInArray } from "../utils/json.utils"
import { KatmerModule } from "../module"
declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      debug?: DebugModuleOptions | string | string[]
    }
  }
}
/**
 * Print messages and/or variable values for troubleshooting.
 *
 * @remarks
 * - Accepts either a **string shorthand** (printed as a message) or a **full options object**.
 * - `msg` entries support template expressions rendered against context.
 * - When `var` is provided, values are looked up from the context using dot-paths (e.g. `"app.version"`).
 * - If nothing is provided, prints a default `"ok"` line.
 *
 * @examples
 * ```yaml
 * # String shorthand
 * - name: quick debug
 *   debug: "Hello from Katmer 🎉"
 *
 * # Multiple messages with expression evaluation
 * - name: deployment banner
 *   debug:
 *     msg:
 *       - "deploying {{ app.name }}"
 *       - "version {{ app.version }}"
 *
 * # Show specific variables (dot-paths allowed)
 * - name: print variables
 *   debug:
 *     label: "context"
 *     var:
 *       - "app.name"
 *       - "env.stage"
 *
 * # Inline values and compact output
 * - name: inline map (no pretty)
 *   debug:
 *     pretty: false
 *     vars:
 *       region: "eu-east"
 *       replicas: 3
 *
 * # Quiet mode (no logger output, result only)
 * - name: return only (no logs)
 *   debug:
 *     msg: "this is silent"
 *     quiet: true
 * ```
 */
export class DebugModule extends KatmerModule<
  DebugModuleOptions,
  DebugModuleResult,
  KatmerProvider
> {
  static name = "debug" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  /**
   * Validate parameters (always allowed; empty input prints "ok").
   */
  async check(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}

  /**
   * Initialize resources (no-op).
   */
  async initialize(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}

  /**
   * Cleanup resources (no-op).
   */
  async cleanup(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}

  /**
   * Render messages and/or variable values and log them.
   *
   * @param ctx - Task context, whose `variables` are used for expression evaluation and lookups.
   * @returns A {@link DebugModuleResult} containing the final printed text and the structured values.
   */
  async execute(
    ctx: Katmer.TaskContext<KatmerProvider>
  ): Promise<DebugModuleResult> {
    const opts = this.#normalizeParams(this.params)

    const {
      msg,
      var: varNames,
      vars,
      label,
      level = "info",
      pretty = true,
      changed = false,
      quiet = false
    } = opts

    const values: Record<string, unknown> = {}
    const lines: string[] = []

    if (label) lines.push(String(label))

    // Messages (with expression evaluation)
    const messages = wrapInArray(msg)
    for (const m of messages) {
      if (m) {
        lines.push(await evalTemplate(m, ctx.variables || {}))
      }
    }

    // var: string | string[]
    if (typeof varNames === "string") {
      values[varNames] = get(ctx.variables ?? {}, varNames)
    } else if (Array.isArray(varNames)) {
      for (const key of varNames) {
        values[key] = get(ctx.variables ?? {}, key)
      }
    }

    // vars: inline object
    if (vars && typeof vars === "object") {
      for (const [k, v] of Object.entries(vars)) values[k] = v
    }

    // Append structured values
    if (Object.keys(values).length > 0) {
      lines.push(this.#formatValue(values, pretty))
    }

    if (lines.length === 0) lines.push("ok")

    const output = lines.join("\n")

    // Log unless quiet
    if (!quiet) {
      const logger = ctx.logger as any
      if (logger?.[level]) logger[level](output)
      else if (typeof ctx.log === "function") ctx.log(level as any, output)
    }

    ctx.logger.info({
      msg: output,
      values
    })
    return {}
  }

  #normalizeParams(
    p?: DebugModuleOptions | string | string[]
  ): DebugModuleOptions {
    if (typeof p === "string") return { msg: p }
    if (Array.isArray(p)) return { msg: p }
    return p ?? { msg: "Hello World" }
  }

  #formatValue(val: unknown, pretty: boolean): string {
    try {
      if (pretty) return JSON.stringify(val, null, 2)
      return typeof val === "string" ? val : JSON.stringify(val)
    } catch {
      return String(val)
    }
  }
}

/**
 * Options for the debug module.
 * @public
 */
export interface DebugModuleOptions {
  /**
   * Text to print. Accepts a single string or an array of strings.
   * Entries support expression syntax.
   */
  msg: string | string[]
  /**
   * Variable name or list of names to print from variables.
   * Dot-paths are supported, e.g. `"app.version"`.
   */
  var?: string | string[]
  /**
   * Inline values to include in the output. Printed as JSON (pretty by default).
   */
  vars?: Record<string, unknown>
  /**
   * Optional header line prepended to the output.
   */
  label?: string
  /**
   * Pretty-print JSON output for objects/maps.
   * @defaultValue true
   */
  pretty?: boolean
  /**
   * Log level.
   * @defaultValue "info"
   */
  level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
  /**
   * If `true`, do not log—only return the output.
   * @defaultValue false
   */
  quiet?: boolean
  /**
   * Force the returned `changed` flag in the result.
   * @defaultValue false
   */
  changed?: boolean
}

/**
 * Result of debug module execution.
 * @public
 */
export interface DebugModuleResult extends ModuleCommonReturn {}
