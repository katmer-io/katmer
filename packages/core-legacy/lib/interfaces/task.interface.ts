import type { KatmerProvider } from "./provider.interface"
import type { KatmerConfig } from "./config.interface"
import type { TwigExpression } from "./executor.interface"
import type { Logger } from "pino"
import type { ProviderResponse } from "../providers/provider_response"
import { KatmerModule } from "../module"

export namespace Katmer {
  /*
   * For plugins
   */
  export interface CustomInclude {
    [key: string]: unknown
  }

  export type IncludeConfig =
    | string
    | {
        file: string
      }
    | {
        remote: string
      }
    | CustomInclude

  /*
   * For plugins
   */
  export interface TaskActions {}

  export interface TaskContext<
    Provider extends KatmerProvider = KatmerProvider
  > {
    exec: (
      command: string,
      options?: Parameters<Provider["executor"]>[0]
    ) => Promise<ProviderResponse>
    execSafe: (
      command: string,
      options?: Parameters<Provider["executor"]>[0]
    ) => Promise<ProviderResponse>
    config: KatmerConfig
    provider: Provider
    variables: Record<string, any>
    progress: (data: Record<string, any>) => void
    logger: Logger
    log: (
      level: "fatal" | "error" | "warn" | "info" | "debug" | "trace",
      ...message: any
    ) => void

    warn(opts: { message: string }): void
    warn(msg: string): void

    fail(msg: string): never
    fail(opts: { message: string }): never
  }

  export interface RuleVariables {
    [key: string]: string
  }

  export interface UntilControl {
    condition: string | TwigExpression
    delay?: number
    retries?: number
  }
  export interface LoopControl {
    for: TwigExpression | (boolean | number | string)[]
    loop_var?: string
    index_var?: string
    pause?: number
    break_when?: string | TwigExpression | (string | TwigExpression)[]
    label?: string | TwigExpression
    extended?: boolean
    extended_allitems?: boolean
  }

  export interface TaskRule {
    loop?: LoopControl | LoopControl["for"]
    until?: UntilControl | UntilControl["condition"]
    when?: string
    register?: string
    allow_failure?: boolean
    variables?: RuleVariables
    environment?: string | Record<string, string>
  }

  export interface Task extends TaskActions, TaskRule {
    name?: string
    targets: string[]
    script?: string[]
  }

  export type Config = {
    include?: IncludeConfig[]
  } & {
    [key: string]: Task
  }
}
