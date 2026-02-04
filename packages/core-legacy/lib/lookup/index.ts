import { EnvLookup } from "./env.lookup"
import { VarLookup } from "./var.lookup"
import { URLLookup } from "./url.lookup"
import { FileLookup } from "./file.lookup"
import { isPlainObject } from "es-toolkit"
import { cls } from "../utils/cls"

export const Lookup = {
  handlers: {
    [EnvLookup.key]: EnvLookup,
    [VarLookup.key]: VarLookup,
    [URLLookup.key]: URLLookup,
    [FileLookup.key]: FileLookup
  },
  async execute(store: string, ...args: any[]) {
    if (!this.handlers[store]) {
      throw new Error(`Unknown lookup store: ${store}`)
    }

    const lastArg = args.at(-1)
    let keys: any[]
    let opts = {} as Record<string, any>
    if (isPlainObject(lastArg)) {
      opts = lastArg
      keys = args.slice(0, -1)
    } else {
      keys = args
    }

    const { default: defaultValue, error, ...options } = opts || {}
    const ctx = cls.getStore()!
    try {
      return (
        (await this.handlers[store].handler(ctx, keys, options)) ?? defaultValue
      )
    } catch (e: any) {
      if (error === "ignore") {
        return defaultValue
      } else if (error === "warn") {
        ctx.logger.warn(`Lookup to ${store} failed: ${e.message}`)
      } else {
        throw e
      }
    }
  }
}
