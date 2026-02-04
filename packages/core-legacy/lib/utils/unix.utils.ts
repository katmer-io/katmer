import type { SSHProvider } from "../providers/ssh/ssh.provider"
import { baseName, targetDir } from "./path.utils"
import { toOctal } from "./number.utils"
import type { Katmer } from "../interfaces/task.interface"

export const UnixComms = {
  escapePOSIX(s: string): string {
    return s.replace(/(["$`\\])/g, "\\$1")
  },
  async fileExists(ctx: Katmer.TaskContext<SSHProvider>, p: string) {
    const r = await ctx.execSafe(`test -e ${JSON.stringify(p)}`)
    return r.code === 0
  },
  /**
   * Checks for the existence of one or more commands on the remote system in a single operation.
   * @param {any} ctx - Katmer task context.
   * @param {string[]} commands - An array of command names to check (e.g., ["git", "node", "npm"]).
   * @returns {Promise<string[]>} A promise that resolves to an array of the command names that were NOT found.
   * An empty array means all commands were found.
   */
  async findMissingCommands(
    ctx: Katmer.TaskContext<any>,
    commands: string[]
  ): Promise<string[]> {
    if (!commands || commands.length === 0) {
      return []
    }

    const commandList = commands.join(" ")
    const checkScript = `for cmd in ${commandList}; do command -v "$cmd" >/dev/null 2>&1 || echo "$cmd"; done`

    const { stdout } = await ctx.exec(checkScript)

    return stdout
      .split("\n")
      .map((s: string) => s.trim())
      .filter(Boolean)
  },

  async mkdirp(ctx: Katmer.TaskContext<any>, dir: string): Promise<void> {
    await ctx.execSafe(`bash -lc 'mkdir -p "${dir}"'`)
  },

  async pathIsFile(ctx: Katmer.TaskContext<any>, p: string): Promise<boolean> {
    const { code } = await ctx.execSafe(`bash -lc '[ -f "${p}" ]'`)
    return code === 0
  },
  async pathIsSymlink(
    ctx: Katmer.TaskContext<any>,
    p: string
  ): Promise<boolean> {
    const { code } = await ctx.execSafe(`bash -lc '[ -L "${p}" ]'`)
    return code === 0
  },
  async readFileUtf8(ctx: Katmer.TaskContext<any>, p: string): Promise<string> {
    const { code, stdout } = await ctx.execSafe(
      `bash -lc '[[ -f "${p}" ]] && cat "${p}" || true'`
    )
    if (code !== 0) return ""
    return stdout
  },
  async readlink(
    ctx: Katmer.TaskContext<any>,
    p: string
  ): Promise<string | null> {
    const { code, stdout } = await ctx.execSafe(
      `bash -lc 'readlink "${p}" || true'`
    )
    return code === 0 ? stdout.trim() : null
  },
  async removePath(ctx: Katmer.TaskContext<any>, p: string): Promise<void> {
    await ctx.execSafe(`bash -lc 'rm -f "${p}" || true'`)
  },
  async writeFileAtomic(
    ctx: Katmer.TaskContext<any>,
    target: string,
    content: string,
    mode?: number
  ): Promise<void> {
    const dir = targetDir(target)
    const base = baseName(target)
    const tmp = `${dir}/.${base}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await ctx.exec(
      `bash -lc 'set -euo pipefail; dir="${UnixComms.escapePOSIX(dir)}"; tmp="${UnixComms.escapePOSIX(tmp)}"; target="${UnixComms.escapePOSIX(
        target
      )}"; mkdir -p "$dir"; : > "$tmp"; cat > "$tmp" << "EOF"\n${content}EOF\n${
        mode != null ? `chmod ${toOctal(mode)} "$tmp"` : ""
      }\nmv -f "$tmp" "$target"'`
    )
  }
}
