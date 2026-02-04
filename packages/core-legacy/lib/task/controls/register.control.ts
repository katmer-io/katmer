import type { KatmerTask } from "../task"
import type { Katmer } from "../../interfaces/task.interface"

const configKey = "register" as const

export const RegisterControl = {
  order: 1000,
  configKey,
  register(task: KatmerTask, cfg?: Katmer.TaskRule[typeof configKey]) {
    if (cfg) {
      const baseExecute = task.execute
      task.execute = async function registerResult(ctx: Katmer.TaskContext) {
        ctx.logger.trace(`[register] start`)

        const result = await baseExecute.call(task, ctx)
        ctx.variables[cfg] = result

        ctx.logger.trace(`[register] end`)
        return result
      }
    }
  }
}
