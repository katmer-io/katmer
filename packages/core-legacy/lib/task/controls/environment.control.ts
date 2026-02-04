import type { KatmerTask } from "../task"
import type { Katmer } from "../../interfaces/task.interface"
import { evalExpr, evalObjectVals } from "../../utils/renderer/renderer"
import { merge } from "es-toolkit/compat"
import { mapValues } from "es-toolkit"

const configKey = "environment" as const

export const EnvironmentControl = {
  order: 10,
  configKey,
  register(task: KatmerTask, cfg?: Katmer.TaskRule[typeof configKey]) {
    task.on("before:execute", async (_task, ctx) => {
      if (cfg || Object.keys(ctx.provider.environment).length > 0) {
        const _exec = ctx.exec

        ctx.exec = async (command, options) => {
          const taskEnv =
            typeof cfg === "string" ? await evalExpr(cfg, ctx.variables) : cfg

          const env = mapValues(
            merge(
              {},
              ctx.provider.environment,
              taskEnv || {},
              options?.env || {}
            ),
            (value) =>
              value !== undefined && value !== null ? String(value) : value
          )

          return _exec(
            command,
            merge({}, options, {
              env: await evalObjectVals(env, ctx.variables)
            })
          )
        }
      }
    })
  }
}
