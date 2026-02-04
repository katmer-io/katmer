import type { SSHProvider } from "../providers/ssh/ssh.provider"
import type { Katmer } from "../interfaces/task.interface"

export const WindowsComms = {
  /**
   * Basic PowerShell string literal quoting using single quotes.
   * Single quotes inside get doubled per PowerShell rules.
   */
  psQuote(s: string): string {
    return "'" + String(s).replace(/'/g, "''") + "'"
  },

  async fileExists(ctx: Katmer.TaskContext<SSHProvider>, p: string) {
    const q = this.psQuote(p)
    const cmd = `powershell -NoProfile -NonInteractive -Command "if (Test-Path -LiteralPath ${q}) { exit 0 } else { exit 1 }"`
    const r = await ctx.exec(cmd)
    return r.code === 0
  },

  async ensureDir(ctx: Katmer.TaskContext<SSHProvider>, dir: string) {
    const q = this.psQuote(dir)
    const cmd = `powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path ${q} | Out-Null"`
    const r = await ctx.exec(cmd)
    if (r.code !== 0) throw new Error(r.stderr || "ensureDir failed")
  },

  async sha256File(ctx: Katmer.TaskContext<SSHProvider>, p: string) {
    const q = this.psQuote(p)
    const cmd = `powershell -NoProfile -NonInteractive -Command "if (Test-Path -LiteralPath ${q}) { (Get-FileHash -Algorithm SHA256 -LiteralPath ${q}).Hash }"`
    const r = await ctx.exec(cmd)
    if (r.code === 0) {
      const h = (r.stdout || "").trim()
      return h ? h.toLowerCase() : null
    }
    return null
  },

  /**
   * Stage bytes from base64 into a file atomically.
   */
  async writeBase64ToFile(
    ctx: Katmer.TaskContext<SSHProvider>,
    dest: string,
    base64: string
  ) {
    const qDest = this.psQuote(dest)
    const qB64 = this.psQuote(base64)
    const script = [
      "param($p,$b)",
      "$dir = Split-Path -LiteralPath $p -Parent",
      "$tmp = [System.IO.Path]::Combine($dir, [System.IO.Path]::GetRandomFileName())",
      "[IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String($b))",
      "Move-Item -Force -LiteralPath $tmp -Destination $p"
    ].join("; ")
    const cmd = `powershell -NoProfile -NonInteractive -Command "${script}" -p ${qDest} -b ${qB64}`
    const r = await ctx.exec(cmd)
    if (r.code !== 0) throw new Error(r.stderr || "writeBase64ToFile failed")
  },

  async copyFile(
    ctx: Katmer.TaskContext<SSHProvider>,
    src: string,
    dest: string
  ) {
    const qSrc = this.psQuote(src)
    const qDest = this.psQuote(dest)
    const cmd = `powershell -NoProfile -NonInteractive -Command "Copy-Item -Force -LiteralPath ${qSrc} -Destination ${qDest}"`
    const r = await ctx.exec(cmd)
    if (r.code !== 0) throw new Error(r.stderr || "copyFile failed")
  },

  async moveFile(
    ctx: Katmer.TaskContext<SSHProvider>,
    src: string,
    dest: string
  ) {
    const qSrc = this.psQuote(src)
    const qDest = this.psQuote(dest)
    const cmd = `powershell -NoProfile -NonInteractive -Command "Move-Item -Force -LiteralPath ${qSrc} -Destination ${qDest}"`
    const r = await ctx.exec(cmd)
    if (r.code !== 0) throw new Error(r.stderr || "moveFile failed")
  },

  async backupIfExists(ctx: Katmer.TaskContext<SSHProvider>, dest: string) {
    const exists = await this.fileExists(ctx, dest)
    if (!exists) return null
    const ts = Date.now()
    const bak = `${dest}.bak.${ts}`
    await this.copyFile(ctx, dest, bak)
    return bak
  }
}
