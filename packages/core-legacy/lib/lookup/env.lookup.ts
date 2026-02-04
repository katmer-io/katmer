import { get } from "es-toolkit/compat"
import type { Katmer } from "../interfaces/task.interface"

export const EnvLookup = {
  key: "env",
  handler: async (
    _ctx: Katmer.TaskContext,
    envKeyParts: string[],
    _opts: Record<string, any>
  ) => {
    return get(process.env, envKeyParts)
  }
}
