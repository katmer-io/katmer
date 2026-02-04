import { AsyncLocalStorage } from "node:async_hooks"
import type { Katmer } from "../interfaces/task.interface"

export const cls = new AsyncLocalStorage<Katmer.TaskContext>()
