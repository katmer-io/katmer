import type { Katmer } from "../interfaces/task.interface"
import fs from "node:fs/promises"
import path from "node:path"

export const FileLookup = {
  key: "file",
  handler: async (
    ctx: Katmer.TaskContext,
    pathParts: string[],
    options = {} as {
      cwd?: string
      encoding?: BufferEncoding
    }
  ) => {
    return await fs.readFile(
      path.resolve(options.cwd || ctx.config.cwd || "", ...pathParts),
      {
        encoding: "utf-8",
        ...options
      }
    )
  }
}
