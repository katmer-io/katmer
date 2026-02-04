import type { ProviderResponse } from "../providers/provider_response"
import type { Katmer } from "../katmer"
import type { KatmerTask } from "../task/task"

export class KatmerError extends Error {}
export class ExecutionFailedError extends KatmerError {
  constructor(
    public result: ProviderResponse,
    public message = "Execution failed"
  ) {
    super(message)
  }
}

export class TaskExecutionFailedError extends ExecutionFailedError {
  task: string | undefined
  constructor(
    task: KatmerTask,
    public result: ProviderResponse,
    public message = "Task execution failed"
  ) {
    super(result, message)
    this.task = task.cfg.name
  }
}
