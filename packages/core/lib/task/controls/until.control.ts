import type { KatmerTask } from "../task"
import type { Katmer } from "../../interfaces/task.interface"
import { evalExpr } from "../../utils/renderer/renderer"
import { delay } from "es-toolkit"
import type { ModuleCommonReturn } from "../../interfaces/module.interface"

const configKey = "until" as const

export const UntilControl = {
  order: 50,
  configKey,
  register(task: KatmerTask, cfg?: Katmer.TaskRule[typeof configKey]) {
    if (cfg) {
      const control =
        cfg && typeof cfg === "object" ?
          cfg
        : {
            condition: cfg || ""
          }
      const baseExecute = task.execute
      task.execute = async function runUntil(ctx: Katmer.TaskContext) {
        let shouldRun = false
        let attempts = 0
        let result = {} as ModuleCommonReturn
        do {
          result = Object.assign(
            result || {},
            await baseExecute.call(task, ctx)
          )

          if (control.condition) {
            const untilResult = await evalExpr(control.condition, ctx.variables)
            if (untilResult) {
              shouldRun = false
            } else {
              if (control.retries && attempts === control.retries + 1) {
                shouldRun = false
                break
              }

              if (!result) {
                result = {} as any
              }
              result.retries = control.retries
              result.attempts = attempts++
              ctx.log("error", {
                msg: `[FAILED]`,
                result: result
              })
              if (control.delay) {
                await delay(control.delay)
              }
            }
          } else {
            ctx.log("debug", "Condition failed")
            shouldRun = false
          }
        } while (shouldRun)

        return result
      }
    }
  }
}
