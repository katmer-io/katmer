// ssh-provider.ts
import { NodeSSH, type Config } from "node-ssh"
import type { ClientChannel, ExecOptions } from "ssh2"
import {
  KatmerProvider,
  type OsInfo,
  type ProviderOptions,
  type SupportedShell
} from "../../interfaces/provider.interface"
import { makeLineEmitter } from "./ssh.utils"
import { pick } from "es-toolkit"
import { merge } from "es-toolkit/compat"

export interface SSHProviderOptions extends ProviderOptions {
  hostname?: string
  port?: number
  username?: string
  password?: string
  private_key?: string
  private_key_password?: string
  shell?: SupportedShell
  timeout?: number // ms
}

import { version } from "../../../package.json"
import { ProviderResponse } from "../provider_response"
import { normalizeArch, normalizeOs } from "../../utils/os.utils"

export interface CommandOptions extends ExecOptions {
  cwd?: string
  shell?: SupportedShell
  timeout?: number
  encoding?: BufferEncoding
  onChannel?: (clientChannel: ClientChannel) => void
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  rewriteCommand?: (preparedCommand: string) => string
  promptMarker?: string
  interactivePassword?: string
  hidePromptLine?: boolean
}

// Detect already-wrapped commands (avoid double wrap)
const SHELL_WRAPPED_RX =
  /^\s*(?:ba?sh|zsh|dash|ksh|mksh|sh|fish)\s+-l?c\s+['"]/i
const PS_WRAPPED_RX = /^\s*powershell(?:\.exe)?\b.*?-Command\s+['"]/i
const CMD_WRAPPED_RX = /^\s*cmd(?:\.exe)?\s+\/(?:d\s+)?\/s\s+\/c\s+["']/i

// Conservative prompt patterns (generic)
const GENERIC_PROMPT_RX = /\b(password|passphrase)\s*(for [^\s:]+)?\s*:\s*$/i
const FAILURE_RX =
  /\b(sorry,\s*try\s*again|incorrect\s*password|permission\s*denied)\b/i

export class SSHProvider extends KatmerProvider<SSHProviderOptions> {
  static name = "ssh"
  client: NodeSSH | null = null

  async check(): Promise<void> {
    if (!this.options.hostname)
      throw new Error("SSHProvider requires a hostname.")
    if (!this.options.username)
      throw new Error("SSHProvider requires a username.")
    if (!this.options.password && !this.options.private_key) {
      throw new Error(
        "SSHProvider requires either a password or a private_key."
      )
    }
  }

  async initialize(): Promise<void> {
    this.client = new NodeSSH()
  }

  async connect(): Promise<void> {
    if (!this.client) throw new Error("SSH client is not initialized.")
    const sshConfig: Config = {
      host: this.options.hostname!,
      ident: `katmer_${version}`,
      port: Number(this.options.port ?? 22),
      username: this.options.username!
    }
    if (this.options.password)
      sshConfig.password = String(this.options.password)
    if (this.options.private_key)
      sshConfig.privateKey = this.options.private_key
    if (this.options.private_key_password)
      sshConfig.passphrase = this.options.private_key_password

    this.logger.debug(
      `Connecting to "${this.options.name || this.options.hostname}"`
    )
    await this.client.connect(sshConfig)
    this.connected = true
  }

  // Expose a safe exec builder (same as before)
  executor(options: CommandOptions = {}) {
    return async (
      command: string,
      execOpts: CommandOptions = {}
    ): Promise<ProviderResponse> => {
      const opts = merge(
        {
          // default shell may be decided dynamically
          shell: (this.options.shell ??
            this.defaultShell ??
            "bash") as SupportedShell,
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
        const shell = opts.shell

        // If already shell-wrapped, don't touch
        if (
          shell === "none" ||
          SHELL_WRAPPED_RX.test(withCwd) ||
          PS_WRAPPED_RX.test(withCwd) ||
          CMD_WRAPPED_RX.test(withCwd)
        ) {
          return withCwd
        }

        // POSIX family
        if (
          shell === "bash" ||
          shell === "zsh" ||
          shell === "sh" ||
          shell === "dash" ||
          shell === "ksh" ||
          shell === "mksh" ||
          shell === "fish"
        ) {
          const flag = shell === "bash" || shell === "zsh" ? "-lc" : "-c"
          const singleQuoted = withCwd.replace(/'/g, "'\\''")
          return `${shell} ${flag} '${singleQuoted}'`
        }

        // Windows shells
        if (shell === "powershell") {
          const ps = withCwd.replace(/'/g, "''")
          return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '${ps}'`
        }
        if (shell === "cmd") {
          const dq = withCwd.replace(/"/g, '\\"')
          return `cmd /d /s /c "${dq}"`
        }

        // Fallback: no wrapping
        return withCwd
      }

      if (!this.client?.isConnected())
        throw new Error("SSH client is not connected.")

      const prepared = prepareCommand(command)
      const finalCommand = opts.rewriteCommand?.(prepared) ?? prepared

      return new Promise<ProviderResponse>((resolve, reject) => {
        const connection = this.client!.connection!
        let timeoutId: NodeJS.Timeout | null = null

        const execOnlyOpts = pick(opts || {}, [
          "allowHalfOpen",
          "env",
          "pty",
          "x11"
        ])
        this.logger.trace({
          msg: `[exec] ${finalCommand}`,
          options: execOnlyOpts
        })
        connection.exec(finalCommand, execOnlyOpts, (err, channel) => {
          if (err)
            return reject(
              new ProviderResponse({
                command: finalCommand,
                stderr: err.message,
                code: 1
              })
            )

          if (opts.timeout && opts.timeout > 0) {
            timeoutId = setTimeout(() => {
              try {
                channel.close()
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

            const hasPrompt =
              opts.promptMarker && text.includes(opts.promptMarker)

            if (
              !pwSent &&
              opts.promptMarker &&
              buffer.includes(opts.promptMarker)
            ) {
              channel.stdin.write(opts.interactivePassword + "\n")
              pwSent = true
            }

            if (!genericPwSent && GENERIC_PROMPT_RX.test(buffer)) {
              channel.stdin.write(opts.interactivePassword + "\n")
              genericPwSent = true
            }

            if (FAILURE_RX.test(buffer)) authDenied = true
            if (buffer.length > 4096) buffer = buffer.slice(-2048)
            return hasPrompt
          }

          channel.on("data", (chunk: Buffer) => {
            const text = chunk.toString(opts.encoding)
            handlePrompts(text)
            emitStdout(text)
          })

          channel.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString(opts.encoding)
            if (!handlePrompts(text)) {
              emitStderr(text)
            }
          })

          let code: number | null = null
          channel.on("exit", (c: any) => {
            code = c ?? null
          })

          channel.on("close", () => {
            if (timeoutId) clearTimeout(timeoutId)
            const result = new ProviderResponse({
              command: finalCommand,
              stdout: stdoutLines.join("\n").trim(),
              stderr: stderrLines.join("\n").trim(),
              code: code ?? (authDenied ? 1 : -1)
            })
            if (result.code === 0) {
              resolve(result)
            } else {
              reject(result)
            }
          })

          channel.on("error", (e: any) => {
            if (timeoutId) clearTimeout(timeoutId)
            reject(
              new ProviderResponse({
                command: finalCommand,
                stdout: stdoutLines.join("\n").trim(),
                stderr: String(e?.message ?? e),
                code: 1
              })
            )
          })
        })
      })
    }
  }

  async destroy(): Promise<void> {
    if (this.client?.isConnected()) {
      this.client.connection?.end()
    }
    this.connected = false
  }

  async cleanup(): Promise<void> {
    this.client?.dispose()
    this.client = null
    this.initialized = false
  }

  /** Probe remote OS/arch as soon as we connect; stores results in `this.osInfo`. */
  async getOsInfo(): Promise<OsInfo> {
    const execRaw = this.executor({ shell: "none", timeout: 5000 })

    // POSIX probe (uname + /etc/os-release)
    const posixScript =
      'OS="$(uname -s 2>/dev/null || true)"; ARCH="$(uname -m 2>/dev/null || true)"; F=""; ' +
      '[ -r /etc/os-release ] && F=/etc/os-release; [ -z "$F" ] && [ -r /usr/lib/os-release ] && F=/usr/lib/os-release; ' +
      'ID=""; VERSION_ID=""; PRETTY_NAME=""; [ -n "$F" ] && . "$F"; ' +
      'printf "__os=%s\\n__arch=%s\\n__id=%s\\n__ver=%s\\n__pretty=%s\\n" "$OS" "$ARCH" "$ID" "$VERSION_ID" "$PRETTY_NAME"'

    let out: ProviderResponse | null = null
    try {
      out = await execRaw(`sh -c '${posixScript.replace(/'/g, "'\\''")}'`)
    } catch {
      // try bash if /bin/sh is missing (rare)
      try {
        out = await execRaw(`bash -lc '${posixScript.replace(/'/g, "'\\''")}'`)
      } catch {
        out = null
      }
    }

    if (out && out.code === 0 && out.stdout) {
      const kv = parseTagged(out.stdout)
      const kernel = (kv.__os || "").trim()
      const archRaw = (kv.__arch || "").trim()
      const fam = normalizeOs(kernel)
      const res: OsInfo = {
        family: fam,
        arch: normalizeArch(archRaw),
        kernel,
        distroId: fam === "windows" ? "windows" : kv.__id || undefined,
        versionId: fam === "windows" ? undefined : kv.__ver || undefined,
        prettyName: kv.__pretty || undefined,
        source: "posix"
      }
      this.os = res
      return res
    }

    // PowerShell probe (Windows)
    const ps = [
      "$arch=$env:PROCESSOR_ARCHITECTURE;",
      "$osCaption=(Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption;",
      "if(-not $osCaption){$osCaption=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue).ProductName}",
      "$ver=(Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Version;",
      "$obj=[ordered]@{os='Windows';arch=$arch;id='windows';version=$ver;pretty=$osCaption};",
      "$obj|ConvertTo-Json -Compress"
    ].join(" ")

    try {
      const r = await execRaw(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '${ps.replace(
          /'/g,
          "''"
        )}'`
      )
      const data = JSON.parse(r.stdout || "{}")
      const res: OsInfo = {
        family: "windows",
        arch: normalizeArch(String(data.arch || "")),
        kernel: "Windows",
        distroId: "windows",
        versionId: data.version || undefined,
        prettyName: data.pretty || undefined,
        source: "powershell"
      }
      this.os = res
      return res
    } catch {
      // fallthrough
    }

    const res: OsInfo = {
      family: "unknown",
      arch: "unknown",
      source: "unknown"
    }
    this.os = res
    return res
  }
}

/* ───────────────────────── utilities ───────────────────────── */

function parseTagged(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(s).split(/\r?\n/)) {
    const m = line.match(/^(__[a-z]+)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
