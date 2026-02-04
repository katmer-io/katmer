import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { evalExpr, evalIterative } from "../utils/renderer/renderer"
import { toMerged } from "es-toolkit"
import { KatmerModule } from "../module"

/**
 * Allow task syntax:
 *
 *   - name: compute values
 *     set_fact:
 *       vars:
 *         release_dir: "{{ app_dir }}/releases/{{ release }}"
 *         stamp: "{{ 1 + 2 }}"
 *       render: true
 */
declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      /** Compute and set variables (facts) on the task context. */
      set_fact?: SetFactModuleOptions
    }
  }
}

/**
 * Options for the set_fact module.
 *
 * You can pass either:
 * - a plain object of key/value pairs, or
 * - `{ vars, render, deep }` for more control
 *
 * When `render` is true, string values that contain templates like `{{ ... }}` are
 * evaluated using the current context scope. When `deep` is true, objects
 * and arrays are traversed and any string leaves are evaluated similarly.
 *
 * @public
 */
export type SetFactModuleOptions =
  | Record<string, unknown>
  | {
      /** Key/value pairs to set on the current context. */
      vars: Record<string, unknown>
      /**
       * Evaluate string templates with `evalExpr`.
       * Only strings that look like templates are evaluated.
       * @defaultValue true
       */
      render?: boolean
      /**
       * Recursively render nested objects/arrays.
       * Only impacts rendering when `render=true`.
       * @defaultValue false
       */
      deep?: boolean
    }

/**
 * Result of the set_fact module.
 * @public
 */
export interface SetFactModuleResult extends ModuleCommonReturn {
  /** The facts that were set (post-render). */
  facts: Record<string, unknown>
}

/**
 * Compute and set variables (facts) on the task context.
 *
 * @remarks
 * - Values are merged into current context.
 * - `changed` is true when a value is added or changed.
 * - When `render=true`, string values that contain `{{ ... }}` are evaluated
 *   with current context as scope. Set `deep=true` to render nested strings as well.
 *
 * @examples
 * ```yaml
 * - name: compute derived paths and flags
 *   set_fact:
 *     vars:
 *       app_dir: /opt/myapp
 *       release: "2025-01-01"
 *       release_dir: "{{ app_dir }}/releases/{{ release }}"
 *       is_prod: "{{ env == 'prod' }}"
 *       nested:
 *         a: "value"
 *         b: "{{ app_dir }}/current"
 *     render: true
 *     deep: true
 *
 * - name: shorthand object (equivalent to vars: {...})
 *   set_fact:
 *     BUILD_ID: "42"
 *     url: "https://example.com/{{ BUILD_ID }}"
 *     # with render=true (default), url becomes "https://example.com/42"
 * ```
 */
export class SetFactModule extends KatmerModule<
  SetFactModuleOptions,
  SetFactModuleResult,
  KatmerProvider
> {
  static name = "set_fact" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  async check(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}
  async initialize(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}
  async cleanup(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}

  async execute(
    ctx: Katmer.TaskContext<KatmerProvider>
  ): Promise<SetFactModuleResult> {
    const { vars, render, deep } = this.#normalize(this.params)

    const before = ctx.variables ?? {}
    const produced: Record<string, unknown> = {}

    // Render each value according to flags, then collect into `produced`.
    for (const [k, v] of Object.entries(vars)) {
      produced[k] =
        render ?
          await evalIterative(v, {
            scope: { ...before, ...produced },
            deep: !!deep
          })
        : v
    }

    // Determine changed by comparing JSON representations of affected keys.
    let changed = false
    for (const [k, nextVal] of Object.entries(produced)) {
      const prevVal = (before as any)[k]
      if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
        changed = true
      }
    }

    // Merge into ctx.variables
    ctx.variables = toMerged(before, produced) as any

    // Optional logging via ctx.logger
    ctx.logger?.debug?.({ msg: "set_fact applied", facts: produced })

    return { changed, facts: produced }
  }

  #normalize(p: SetFactModuleOptions | undefined): {
    vars: Record<string, unknown>
    render: boolean
    deep: boolean
  } {
    if (!p) return { vars: {}, render: true, deep: false }
    if (typeof p === "object" && "vars" in p) {
      return {
        vars: (p.vars || {}) as Record<string, unknown>,
        render: p.render !== false,
        deep: !!p.deep
      }
    }
    return { vars: p as Record<string, unknown>, render: true, deep: false }
  }
}
