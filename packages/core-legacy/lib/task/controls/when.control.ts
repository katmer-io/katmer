import type { KatmerTask } from "../task"
import type { Katmer } from "../../interfaces/task.interface"
import { evalExpr } from "../../utils/renderer/renderer"

const configKey = "when" as const

export const WhenControl = {
  order: 10,
  configKey,
  register(task: KatmerTask, cfg?: Katmer.TaskRule[typeof configKey]) {
    if (cfg) {
      const baseExecute = task.execute
      task.execute = async function runWhen(ctx: Katmer.TaskContext) {
        const whenResult = await evalExpr(cfg, ctx.variables)
        if (!whenResult) {
          return {
            changed: false,
            skipped: true
          }
        }
        return await baseExecute.call(task, ctx)
      }
    }
  }
}
