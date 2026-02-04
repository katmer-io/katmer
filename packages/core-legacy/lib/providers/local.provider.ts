// local-provider.ts
import {
  KatmerProvider,
  type OsInfo,
  type ProviderOptions,
  type SupportedShell
} from "../interfaces/provider.interface"
import * as child_process from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { makeLineEmitter } from "./ssh/ssh.utils"
import { merge } from "es-toolkit/compat"
import { ProviderResponse } from "./provider_response"

// NEW: extra imports for OS detection
import * as os from "node:os"
import * as fs from "node:fs/promises"
import { normalizeArch, normalizeOs } from "../utils/os.utils"

export interface LocalProviderOptions extends ProviderOptions {}

export interface CommandOptions {
  cwd?: string
  shell?: SupportedShell
  timeout?: number
  env?: Record<string, string>
  encoding?: BufferEncoding
  onChannel?: (clientChannel: ChildProcess) => void
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void

  rewriteCommand?: (preparedCommand: string) => string
  promptMarker?: string
  interactivePassword?: string
  hidePromptLine?: boolean
}

// Conservative prompt patterns (generic)
const GENERIC_PROMPT_RX = /\b(password|passphrase)\s*(for [^\s:]+)?\s*:\s*$/i
const FAILURE_RX =
  /\b(sorry,\s*try\s*again|incorrect\s*password|permission\s*denied)\b/i

export class LocalProvider extends KatmerProvider<LocalProviderOptions> {
  static name = "local"

  async check(): Promise<void> {}
  async initialize(): Promise<void> {}
  async connect(): Promise<void> {}

  /**
   * Detect controller OS/arch quickly using Node APIs with light fallbacks.
   * Populates `this.os` and returns the same object.
   */
  async getOsInfo(): Promise<OsInfo> {
    // Base facts from Node
    const kernelRaw = os.type() || "" // 'Linux' | 'Darwin' | 'Windows_NT'
    const family = normalizeOs(kernelRaw)
    // Prefer PROCESSOR_ARCHITECTURE on Windows; otherwise process.arch
    const archRaw =
      process.platform === "win32" ?
        process.env.PROCESSOR_ARCHITECTURE || process.arch
      : process.arch
    const info: OsInfo = {
      family,
      arch: normalizeArch(String(archRaw || "")),
      kernel: kernelRaw,
      source: "posix"
    }

    try {
      if (family === "linux") {
        const file =
          (await fileIfExists("/etc/os-release")) ??
          (await fileIfExists("/usr/lib/os-release"))
        if (file) {
          const env = parseOsRelease(await fs.readFile(file, "utf8"))
          info.distroId = env.ID ?? info.distroId
          info.versionId = env.VERSION_ID ?? info.versionId
          info.prettyName = env.PRETTY_NAME ?? info.prettyName
        }
      } else if (family === "darwin") {
        // sw_vers is standard on macOS
        const [productName, productVersion] = await Promise.all([
          tryExec("sw_vers", ["-productName"]),
          tryExec("sw_vers", ["-productVersion"])
        ])
        if (productName || productVersion) {
          info.distroId = "macos"
          info.versionId = productVersion?.trim() || undefined
          info.prettyName = [productName?.trim(), productVersion?.trim()]
            .filter(Boolean)
            .join(" ")
        }
      } else if (family === "windows") {
        // Best-effort pretty/version via PowerShell (if available)
        const ps = await tryExec("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          [
            "$cap=(Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption;",
            "if(-not $cap){$cap=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue).ProductName};",
            "$ver=(Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Version;",
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8;",
            "Write-Output ($cap);",
            "Write-Output ($ver)"
          ].join(" ")
        ])
        if (ps) {
          const lines = ps.split(/\r?\n/)
          info.distroId = "windows"
          info.prettyName = (lines[0] || "").trim() || info.prettyName
          info.versionId = (lines[1] || "").trim() || info.versionId
          info.source = "powershell"
        } else {
          info.distroId = "windows"
          info.source = "powershell"
        }
      }
    } catch {
      // keep minimal info; we already have family/arch/kernel
    }

    this.os = info
    return info
  }

  executor(options: CommandOptions = {}) {
    return async (
      command: string,
      execOpts: CommandOptions = {}
    ): Promise<ProviderResponse> => {
      const opts = merge(
        {
          encoding: "utf-8",
          interactivePassword: "",
          hidePromptLine: true
        },
        this.options,
        options,
        execOpts
      ) as CommandOptions

      const prepareCommand = (command: string): string => {
        const withCwd =
          opts.cwd ? `cd ${JSON.stringify(opts.cwd)} && ${command}` : command
        return `${withCwd.replace(/'/g, "'\\''")}`
      }

      const prepared = prepareCommand(command)
      const finalCommand = opts.rewriteCommand?.(prepared) ?? prepared

      return new Promise<ProviderResponse>(async (resolve, reject) => {
        let timeoutId: NodeJS.Timeout | null = null

        this.logger.trace(`[exec] %s`, finalCommand)

        // FIX: if opts.shell === "none", do NOT pass the literal string to Node.
        // Use platform default shell (true) instead.
        const shellOpt =
          opts.shell && opts.shell !== "none" ? (opts.shell as any) : true

        const channel = child_process.spawn(finalCommand, {
          shell: shellOpt,
          stdio: "pipe",
          env: opts.env,
          cwd: opts.cwd
        })

        if (opts.timeout && opts.timeout > 0) {
          timeoutId = setTimeout(() => {
            try {
              channel.kill()
            } catch {}
            reject(
              new ProviderResponse({
                command: finalCommand,
                stderr: `Command timed out after ${opts.timeout}ms`,
                code: 1
              })
            )
          }, opts.timeout)
        }

        opts.onChannel?.(channel)

        const stdoutLines: string[] = []
        const stderrLines: string[] = []
        const emitStdout = makeLineEmitter((line) => {
          if (
            !(
              opts.hidePromptLine &&
              opts.promptMarker &&
              line.includes(opts.promptMarker)
            )
          ) {
            opts.onStdout?.(line)
            stdoutLines.push(line)
          }
        })
        const emitStderr = makeLineEmitter((line) => {
          if (
            !(
              opts.hidePromptLine &&
              opts.promptMarker &&
              line.includes(opts.promptMarker)
            )
          ) {
            opts.onStderr?.(line)
            stderrLines.push(line)
          }
        })

        let pwSent = false
        let genericPwSent = false
        let authDenied = false
        let buffer = ""

        const handlePrompts = (text: string) => {
          buffer += text

          if (
            !pwSent &&
            opts.promptMarker &&
            buffer.includes(opts.promptMarker)
          ) {
            channel.stdin?.write(opts.interactivePassword + "\n")
            pwSent = true
          }

          if (!genericPwSent && GENERIC_PROMPT_RX.test(buffer)) {
            channel.stdin?.write(opts.interactivePassword + "\n")
            genericPwSent = true
          }

          if (FAILURE_RX.test(buffer)) authDenied = true
          if (buffer.length > 4096) buffer = buffer.slice(-2048)
        }

        channel.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString(opts.encoding)
          handlePrompts(text)
          emitStdout(text)
        })

        channel.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString(opts.encoding)
          handlePrompts(text)
          emitStderr(text)
        })

        let code: number | null = null
        channel.on("exit", (c: any) => {
          code = c ?? null
        })

        channel.on("close", () => {
          if (timeoutId) clearTimeout(timeoutId)
          const result = new ProviderResponse({
            command: finalCommand,
            stdout: stdoutLines.join("\n"),
            stderr: stderrLines.join("\n"),
            code: code ?? (authDenied ? 1 : -1)
          })
          if (result.code === 0) {
            resolve(result)
          } else {
            reject(result as unknown as Error)
          }
        })

        channel.on("error", (e: any) => {
          if (timeoutId) clearTimeout(timeoutId)
          reject(
            new ProviderResponse({
              command: finalCommand,
              stdout: stdoutLines.join("\n"),
              stderr: String(e?.message ?? e),
              code: 1
            })
          )
        })
      })
    }
  }

  async destroy(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

/* ───────────────────────── helpers ───────────────────────── */

// read first existing file path (returns path or null)
async function fileIfExists(p: string): Promise<string | null> {
  try {
    await fs.access(p)
    return p
  } catch {
    return null
  }
}

function parseOsRelease(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    const k = m[1]
    let v = m[2]
    // strip quotes if present
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

async function tryExec(cmd: string, args: string[]): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = child_process.execFile(
      cmd,
      args,
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        resolve(stdout?.toString() ?? "")
      }
    )
    child.on("error", () => resolve(null))
  })
}
