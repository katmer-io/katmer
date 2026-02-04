export interface ExecutionResult {
  command: string
  code: number
  stdout?: string
  stderr?: string
}

export class ProviderResponse implements ExecutionResult {
  constructor(opts: ExecutionResult) {
    Object.assign(this, opts)
  }
  toString() {
    return (this.stderr || this.stdout || "")?.trim()
  }

  code!: number
  command!: string
  stderr!: string
  stdout!: string
}
