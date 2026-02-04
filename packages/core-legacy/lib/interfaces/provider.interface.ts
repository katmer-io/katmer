import type { ProviderResponse } from "../providers/provider_response"
import type { StandardLogger } from "./config.interface"

export type OsFamily =
  | "any"
  | "linux"
  | "darwin"
  | "windows"
  | "freebsd"
  | "openbsd"
  | "netbsd"
  | "aix"
  | "solaris"
  | "unknown"

export type OsArch =
  | "x86_64"
  | "arm64"
  | "armv7"
  | "armv6"
  | "i386"
  | "ppc64le"
  | "s390x"
  | "riscv64"
  | "loongarch64"
  | "any"
  | "unknown"

// Added powershell/cmd; keep "none" for raw passthrough
export type SupportedShell =
  | "bash"
  | "sh"
  | "zsh"
  | "dash"
  | "ksh"
  | "mksh"
  | "fish"
  | "powershell"
  | "cmd"
  | "none"
export interface ProviderOptions {
  name?: string
  shell?: SupportedShell
  timeout?: number
  retries?: number
  [key: string]: any
}

export interface OsInfo {
  family: OsFamily
  arch: OsArch
  kernel?: string
  distroId?: string
  versionId?: string
  prettyName?: string
  source: "posix" | "powershell" | "unknown"
}

/**
 * Abstract base class for all Katmer providers.
 * Providers define how tasks are executed (SSH, Local, AWS SSM, GCP, etc.)
 */
export abstract class KatmerProvider<
  TOptions extends ProviderOptions = ProviderOptions
> {
  static readonly name: string
  type: string

  defaultShell: SupportedShell = "sh"
  os: OsInfo = {
    family: "unknown",
    arch: "unknown",
    source: "unknown"
  }
  logger!: StandardLogger
  options: TOptions

  connected = false
  initialized = false

  variables: Record<string, any> = {}
  environment: Record<string, string> = {}

  constructor(options: TOptions) {
    this.options = options
    this.type = this.constructor.name
  }

  /**
   * Validate configuration before use (e.g., check required fields).
   */
  abstract check(): Promise<void>

  /**
   * Initialize resources (e.g., allocate clients, prepare temp dirs).
   */
  abstract initialize(): Promise<void>

  /**
   * Establish connection/session.
   */
  abstract connect(): Promise<void>

  /**
   * Execute a command within this provider's context.
   */
  abstract executor(
    options?: Record<string, any>
  ): (
    command: string,
    options?: Record<string, any>
  ) => Promise<ProviderResponse>

  /**
   * Tear down connection/session (but keep reusable state).
   */
  abstract destroy(): Promise<void>

  /**
   * Cleanup all allocated resources (irreversible).
   */
  abstract cleanup(): Promise<void>

  /** Probe remote OS/arch as soon as we connect; called automatically on `ensureReady()` */
  abstract getOsInfo(): Promise<OsInfo>

  /** Pick the best shell based on OS and availability; sets `this.options.shell`. */
  async decideDefaultShell(): Promise<SupportedShell> {
    const execRaw = this.executor({ shell: "none", timeout: 4000 })

    // Windows → prefer PowerShell, fallback to cmd
    if (this.os.family === "windows") {
      try {
        const r = await execRaw(
          `powershell -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.Major"`
        )
        if (r.code === 0) {
          this.defaultShell = "powershell"
          return "powershell"
        }
      } catch {}
      this.defaultShell = "cmd"
      return "cmd"
    }

    // POSIX → choose first available, prefer bash/zsh
    const probe =
      'for s in bash zsh ksh mksh dash sh fish; do command -v "$s" >/dev/null 2>&1 && { echo "$s"; exit 0; }; done; echo sh'
    let chosen = "sh"
    try {
      const r = await execRaw(`sh -c '${probe}'`)
      if (r.code === 0 && r.stdout?.trim()) chosen = r.stdout.trim()
    } catch {
      // fallback to bash if sh probing failed
      try {
        const r2 = await execRaw(`bash -lc '${probe}'`)
        if (r2.code === 0 && r2.stdout?.trim()) chosen = r2.stdout.trim()
      } catch {}
    }

    // normalize to SupportedShell
    const asShell =
      (["bash", "zsh", "ksh", "mksh", "dash", "sh", "fish"].find(
        (s) => s === chosen
      ) as SupportedShell) || "sh"

    this.defaultShell = asShell
    return asShell
  }

  /**
   * Helper to ensure full lifecycle (for convenience in orchestrators).
   */
  async ensureReady(): Promise<this> {
    if (!this.initialized) {
      await this.check()
      await this.initialize()
      this.initialized = true
    }
    if (!this.connected) {
      await this.connect()

      this.os = await this.getOsInfo()
      await this.decideDefaultShell()

      this.connected = true
    }
    return this
  }

  /**
   * Safe shutdown wrapper that handles errors gracefully.
   */
  async safeShutdown(): Promise<void> {
    try {
      await this.destroy()
      this.connected = false
    } catch (err) {
      console.warn(`[Provider:${this.options.name}] destroy() failed:`, err)
    }

    try {
      await this.cleanup()
      this.initialized = false
    } catch (err) {
      console.warn(`[Provider:${this.options.name}] cleanup() failed:`, err)
    }
    this.logger.trace(`Disconnected from provider: ${this.options.name}`)
  }

  async [Symbol.asyncDispose]() {
    await this.safeShutdown()
  }
}
