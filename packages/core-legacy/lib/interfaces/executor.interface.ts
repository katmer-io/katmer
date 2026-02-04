export type TwigExpression = `{{${string}}}`
// common interface so AptRepositoryModule does not depend on SSH
export interface Executor {
  run(
    command: string,
    options?: {
      cwd?: string
      encoding?: BufferEncoding
      onStdout?: (line: string) => void
      onStderr?: (line: string) => void
    }
  ): Promise<{ stdout: string; stderr: string; code: number }>
}
