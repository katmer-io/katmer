import { LoopControl } from "./loop.control"
import { RegisterControl } from "./register.control"
import { WhenControl } from "./when.control"
import { UntilControl } from "./until.control"
import { sortBy } from "es-toolkit"
import { EnvironmentControl } from "./environment.control"

export const TaskControls = sortBy(
  [LoopControl, RegisterControl, WhenControl, UntilControl, EnvironmentControl],
  ["order"]
)

export const TaskControlKeys = TaskControls.map((ctrl) => ctrl.configKey)
