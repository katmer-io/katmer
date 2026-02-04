import { isPlainObject } from "es-toolkit"
import type { Katmer } from "../interfaces/task.interface"

export const URLLookup = {
  key: "url",
  handler: async (
    _ctx: Katmer.TaskContext,
    urlParts: string[],
    options = {} as RequestInit
  ) => {
    const url = new URL(urlParts.join("/"))
    const res = await fetch(url, options)
    if (res.ok) {
      return await res.text()
    } else {
      throw new Error(
        `Failed to fetch url: ${url} status: ${res.status} response: ${(await res.text()) ?? "no response"}`
      )
    }
  }
}
