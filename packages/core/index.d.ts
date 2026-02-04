export namespace Katmer {
  export type Task = {
    name?: string
    targets?: string[]
    when?: string
    loop_control?: unknown
    register?: string
    allow_failure?: boolean
    variables?: Record<string, unknown>
    environment?: Record<string, string>
    [module: string]: unknown
  }
}

export type KatmerCoreOptions = {
  cwd?: string
  target?: string[] | string
}

export class KatmerCore {
  logger: unknown
  constructor(opts: KatmerCoreOptions)
  init(): Promise<void>
  loadConfig(config?: unknown): Promise<void>
  check(): Promise<void>
  run(file: string): Promise<void>
}
