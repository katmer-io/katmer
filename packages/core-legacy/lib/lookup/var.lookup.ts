import { get } from "es-toolkit/compat"
import type { Katmer } from "../interfaces/task.interface"

export const VarLookup = {
  key: "var",
  handler: async (
    ctx: Katmer.TaskContext,
    varParts: string[],
    _opts: Record<string, any>
  ) => {
    return get(ctx.variables, varParts)
  }
}
