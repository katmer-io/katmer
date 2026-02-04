import type { Katmer } from "../../interfaces/task.interface"
import { defaults, isObjectLike } from "es-toolkit/compat"
import { wrapInArray } from "../../utils/json.utils"
import type { KatmerTask } from "../task"
import { evalExpr } from "../../utils/renderer/renderer"
import type { ModuleCommonReturn } from "../../interfaces/module.interface"

const configKey = "loop" as const
export const LoopControl = {
  order: 100,
  configKey,
  register(task: KatmerTask, cfg?: Katmer.TaskRule[typeof configKey]) {
    if (cfg) {
      const control = defaults(
        cfg && typeof cfg === "object" && "for" in cfg ?
          cfg
        : {
            for: (cfg || []) as string[] | string
          },
        {
          for: [] as string[],
          index_var: "index",
          break_when: [] as string[],
          loop_var: "item",
          extended: false,
          extended_allitems: true
        } satisfies Katmer.LoopControl
      )
      control.break_when = wrapInArray(control.break_when)

      const baseExecute = task.execute
      task.execute = async function runWithLoop(ctx: Katmer.TaskContext) {
        ctx.logger.trace(`[loop] start`)
        const loops =
          typeof control.for === "string" ? await evalExpr(control.for)
          : isObjectLike(control.for) ? control.for
          : []

        const loopEntries = Object.entries(loops)
        const loopItems = Object.values(loops)
        const loopResults = {
          changed: false,
          skipped: undefined as boolean | undefined,
          failed: false,
          results: [] as (ModuleCommonReturn | { skipped: true })[]
        }
        taskLoop: for (let i = 0; i < loopEntries.length; i++) {
          const [loop_key, loop_val] = loopEntries[i]
          ctx.variables[control.index_var] = loop_key
          ctx.variables[control.loop_var] = loop_val

          if (control.extended) {
            ctx.variables.katmer_loop = {
              allitems: control.extended_allitems ? loopItems : undefined,
              index: i + 1,
              index0: i,
              revindex: loopItems.length - i,
              revindex0: loopItems.length - i - 1,
              first: i === 0,
              last: i === loopItems.length - 1,
              length: loopItems.length,
              previtem: loopItems[i - 1],
              nextitem: loopItems[i + 1]
            }
          }
          ctx.logger.trace(`[loop] ${i} ${loop_key} ${loop_val}`)
          const result = await baseExecute.call(task, ctx)

          if (result) {
            result.item = loop_val
            loopResults.changed = loopResults.changed || result.changed
            loopResults.failed = loopResults.failed || !!result.failed
            loopResults.skipped = !!(result.skipped && loopResults.skipped)
            loopResults.results.push(result)
          }

          for (const condition of control.break_when) {
            if (await evalExpr(condition, ctx.variables)) {
              break taskLoop
            }
          }
        }
        ctx.logger.trace(`[loop] end`)

        return loopResults
      }
    }
  }
}
