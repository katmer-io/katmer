// packages/core/modules/template.module.ts
import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { SSHProvider } from "../providers/ssh/ssh.provider"
import type { LocalProvider } from "../providers/local.provider"
import { evalTemplate } from "../utils/renderer/renderer"
import { toMerged } from "es-toolkit"
import fs from "node:fs/promises"
import path from "node:path"
import { toOctal } from "../utils/number.utils"
import { KatmerModule } from "../module"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      template?: TemplateModuleOptions
    }
  }
}
/**
 * Options for the `template` module.
 *
 * Renders a Twig template (from inline `content` or a file `src`) **locally** using
 * the merged data context and writes the rendered result to `dest`.
 * - On **SSH** providers, writes to the remote via shell, preserving atomicity with a temp file.
 * - On **Local** provider, writes directly using Node.js `fs` APIs (no shell).
 *
 * @public
 */
export interface TemplateModuleOptions {
  /**
   * Inline template string (Twig syntax supported).
   * One of {@link TemplateModuleOptions.content | content} or {@link TemplateModuleOptions.src | src} is required.
   *
   * @example
   * ```yaml
   * template:
   *   content: |
   *     server_name {{ domain }};
   *     listen {{ port }};
   *   dest: "/etc/myapp/site.conf"
   * ```
   */
  content?: string

  /**
   * Local file path to read the template from (Twig syntax supported).
   * One of {@link TemplateModuleOptions.src | src} or {@link TemplateModuleOptions.content | content} is required.
   *
   * @example
   * ```yaml
   * template:
   *   src: "./_source/site.conf.twig"
   *   dest: "/etc/myapp/site.conf"
   * ```
   */
  src?: string

  /**
   * Destination path to write the rendered output into.
   * - **SSH**: remote absolute path on the target host.
   * - **Local**: local filesystem path.
   */
  dest: string

  /**
   * Extra variables merged **on top of** the current context for this render only.
   * Task/target variables remain intact; these act as per-render overrides.
   */
  variables?: Record<string, any>

  /**
   * File permissions to apply on `dest`.
   * Accepts octal number (e.g., `0o644`) or string (e.g., `"0644"`).
   * @defaultValue `"0644"`
   */
  mode?: string | number

  /**
   * File owner to apply on `dest`.
   * - **SSH**: accepts a username (e.g., `"root"`).
   * - **Local**: must be **numeric uid**; otherwise the chown attempt is skipped and a warning is logged.
   */
  owner?: string

  /**
   * File group to apply on `dest`.
   * - **SSH**: accepts a group name (e.g., `"www-data"`).
   * - **Local**: must be **numeric gid**; otherwise the chown attempt is skipped and a warning is logged.
   */
  group?: string

  /**
   * If `true`, do not write anything; returns the rendered content in {@link TemplateModuleResult.stdout | stdout}.
   * @defaultValue false
   */
  dry_run?: boolean

  /**
   * If `true`, compares the existing file content with the newly rendered result.
   * When identical, the module returns `changed=false` without writing.
   * @defaultValue true
   */
  diff_check?: boolean
}

export interface TemplateModuleResult extends ModuleCommonReturn {
  /** Destination path that was written (or examined). */
  dest?: string
  /** File mode applied to `dest` (octal string, e.g. `"0644"`). */
  mode?: string
  /** File owner applied to `dest`. */
  owner?: string
  /** File group applied to `dest`. */
  group?: string
}

/**
 * Render a Twig template locally and deploy the result to a file (remote for SSH, local for Local).
 *
 * @remarks
 * - Renders with the current context + per-call `variables`.
 * - If {@link TemplateModuleOptions.diff_check | diff_check} is `true` (default), content is compared to avoid needless writes.
 * - On **SSH**:
 *   - Ensures parent directory via shell (`mkdir -p`).
 *   - Writes through a temporary file and installs atomically (`install -m … -D` or `mv` fallback).
 *   - Applies `chmod`/`chown` when requested.
 * - On **Local**:
 *   - Uses pure Node.js (`fs.mkdir`, `fs.readFile`, `fs.writeFile`, `fs.rename`, `fs.chmod`, `fs.chown`).
 *   - `owner`/`group` must be numeric (`uid`/`gid`).
 *
 * @examples
 * ```yaml
 * - name: Render inline text template
 *   template:
 *     content: |
 *       server_name {{ domain }};
 *       listen {{ port }};
 *     dest: "/etc/myapp/config.conf"
 *     mode: "0644"
 *     owner: "root"
 *     group: "root"
 *     variables:
 *       domain: "example.com"
 *       port: 8080
 *
 * - name: Read template from local file
 *   template:
 *     src: "./_source/metadata.yaml.twig"
 *     dest: "/etc/myapp/metadata.yaml"
 *     variables:
 *       app: "demo"
 *
 * - name: Dry run (only preview rendered content)
 *   template:
 *     src: "./_source/site.conf.twig"
 *     dest: "/etc/nginx/sites-available/site.conf"
 *     dry_run: true
 * ```
 *
 * @public
 */
export class TemplateModule extends KatmerModule<
  TemplateModuleOptions,
  TemplateModuleResult,
  KatmerProvider
> {
  static name = "template" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  async check(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {
    const { content, src, dest } = this.params || ({} as TemplateModuleOptions)
    if (!dest || typeof dest !== "string" || !dest.trim()) {
      throw new Error("'dest' is required")
    }
    if (
      (content == null || typeof content !== "string") &&
      (src == null || typeof src !== "string")
    ) {
      throw new Error("one of 'content' or 'src' must be provided")
    }
    if (src != null && typeof src !== "string") {
      throw new Error("'src' must be a string path")
    }
  }

  async initialize(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}
  async cleanup(_ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {}

  async execute(
    ctx: Katmer.TaskContext<KatmerProvider>
  ): Promise<TemplateModuleResult> {
    const {
      content,
      src,
      dest,
      variables = {},
      mode = "0644",
      owner,
      group,
      dry_run = false,
      diff_check = true
    } = this.params

    // Resolve template source (src or content)
    let templateString: string
    try {
      if (typeof src === "string" && src.trim()) {
        const abs = path.resolve(...[ctx.config.cwd!, src].filter(Boolean))
        templateString = await fs.readFile(abs, "utf8")
      } else {
        templateString = String(content ?? "")
      }
    } catch (e: any) {
      throw {
        changed: false,
        msg: `failed to read src: ${e?.message || String(e)}`
      } as TemplateModuleResult
    }

    // Render locally using Twig renderer
    let rendered: string
    try {
      rendered = await evalTemplate(
        templateString,
        toMerged(ctx.variables, variables)
      )
    } catch (e: any) {
      throw {
        changed: false,
        msg: `template render failed: ${e?.message || String(e)}`
      } as TemplateModuleResult
    }

    // Dry-run — just return the would-be content
    if (dry_run) {
      return {
        changed: false,
        dest,
        mode: toModeString(mode),
        owner,
        group,
        stdout: rendered
      }
    }

    // Branch by provider type
    if (ctx.provider instanceof SSHProvider) {
      return await this.executeSSH(ctx as Katmer.TaskContext<SSHProvider>, {
        rendered,
        dest,
        mode,
        owner,
        group,
        diff_check
      })
    } else {
      return await this.executeLocal(ctx as Katmer.TaskContext<LocalProvider>, {
        rendered,
        dest,
        mode,
        owner,
        group,
        diff_check
      })
    }
  }

  // ── SSH path (shell-based; mirrors your previous behavior) ───────────────────
  private async executeSSH(
    ctx: Katmer.TaskContext<SSHProvider>,
    opts: {
      rendered: string
      dest: string
      mode?: string | number
      owner?: string
      group?: string
      diff_check: boolean
    }
  ): Promise<TemplateModuleResult> {
    const { rendered, dest, mode, owner, group, diff_check } = opts
    const q = (v: string) => JSON.stringify(v)

    // Ensure parent directory
    const mk = await ctx.exec(`mkdir -p -- "$(dirname ${q(dest)})"`)
    if (mk.code !== 0) {
      throw {
        changed: false,
        msg: mk.stderr || mk.stdout || "failed to ensure destination directory"
      }
    }

    // Fail if dest is a directory
    const isDir = await ctx.exec(`test -d ${q(dest)} >/dev/null 2>&1; echo $?`)
    if (String(isDir.stdout).trim() === "0") {
      throw {
        changed: false,
        msg: `'${dest}' is a directory`
      } as TemplateModuleResult
    }

    // Diff check
    if (diff_check) {
      const exists = await ctx.exec(
        `test -f ${q(dest)} >/dev/null 2>&1; echo $?`
      )
      if (String(exists.stdout).trim() === "0") {
        const read = await ctx.exec(`cat ${q(dest)}`)
        if (read.code === 0 && read.stdout === rendered) {
          await applyMetaSSH(ctx, dest, mode, owner, group).catch(() => {})
          return {
            changed: false,
            dest,
            mode: toModeString(mode),
            owner,
            group
          }
        }
      }
    }

    // Write via temp + install
    const tmp = `/tmp/katmer-template-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    const writeTmp = await ctx.exec(`cat > ${q(tmp)} << "KATMER_EOF"
${rendered}
KATMER_EOF`)
    if (writeTmp.code !== 0) {
      await ctx.exec(`rm -f -- ${q(tmp)}`).catch(() => {})
      throw {
        changed: false,
        msg: writeTmp.stderr || writeTmp.stdout || "failed to write temp file"
      }
    }

    const modeStr = toModeString(mode) ?? "0644"
    const installCmd = `install -m ${modeStr} -D ${q(tmp)} ${q(dest)} || mv -f ${q(tmp)} ${q(dest)}`
    const mv = await ctx.exec(installCmd)
    await ctx.exec(`rm -f -- ${q(tmp)}`).catch(() => {})
    if (mv.code !== 0) {
      throw {
        changed: false,
        msg: mv.stderr || mv.stdout || "failed to install rendered file"
      }
    }

    await applyMetaSSH(ctx, dest, mode, owner, group).catch(() => {})

    return { changed: true, dest, mode: toModeString(mode), owner, group }
  }

  // ── Local path (pure Node.js; no shell) ──────────────────────────────────────
  private async executeLocal(
    ctx: Katmer.TaskContext<LocalProvider>,
    opts: {
      rendered: string
      dest: string
      mode?: string | number
      owner?: string
      group?: string
      diff_check: boolean
    }
  ): Promise<TemplateModuleResult> {
    const { rendered, dest, owner, group, diff_check } = opts
    const mode = toOctal(opts.mode)
    const parent = path.dirname(dest)
    await fs.mkdir(parent, { recursive: true })

    // Guard: dest is not a directory
    try {
      const st = await fs.stat(dest)
      if (st.isDirectory()) {
        throw {
          changed: false,
          msg: `'${dest}' is a directory`
        } as TemplateModuleResult
      }
    } catch {
      /* not existing is fine */
    }

    // Diff check
    if (diff_check) {
      try {
        const current = await fs.readFile(dest, "utf8")
        if (current === rendered) {
          await applyMetaLocal(dest, mode, owner, group, ctx).catch(() => {})
          return {
            changed: false,
            dest,
            mode: toModeString(mode),
            owner,
            group
          }
        }
      } catch {
        /* file missing → proceed */
      }
    }

    // Atomic-ish write: tmp → rename
    const tmp = path.join(
      parent,
      `.katmer-template-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    )
    await fs.writeFile(tmp, rendered, "utf8")
    await fs.rename(tmp, dest)

    await applyMetaLocal(dest, mode, owner, group, ctx).catch(() => {})

    return { changed: true, dest, mode: toModeString(mode), owner, group }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function toModeString(mode?: string | number) {
  if (mode == null) return undefined
  return typeof mode === "number" ? "0" + mode.toString(8) : mode
}

async function applyMetaSSH(
  ctx: Katmer.TaskContext<SSHProvider>,
  dest: string,
  mode?: string | number,
  owner?: string,
  group?: string
) {
  const q = (v: string) => JSON.stringify(v)
  if (mode != null) {
    await ctx.exec(`chmod ${mode} -- ${q(dest)}`)
  }
  if (owner || group) {
    const chownArg =
      owner && group ? `${owner}:${group}`
      : owner ? owner
      : `:${group}`
    await ctx.exec(`chown ${q(chownArg)} -- ${q(dest)}`)
  }
}

async function applyMetaLocal(
  dest: string,
  mode?: string,
  owner?: string,
  group?: string,
  ctx?: Katmer.TaskContext<LocalProvider>
) {
  if (mode != null) {
    await fs.chmod(dest, parseInt(mode, 8))
  }
  if (owner != null || group != null) {
    const st = await fs.stat(dest)
    const uid = parseNumericId(owner) ?? st.uid
    const gid = parseNumericId(group) ?? st.gid
    if (uid !== st.uid || gid !== st.gid) {
      try {
        await fs.chown(dest, uid, gid)
      } catch (e) {
        ctx?.warn?.({
          message: `local chown failed; owner/group must be numeric uid/gid. ${String(e)}`
        })
      }
    }
  }
}

function parseNumericId(v?: string): number | undefined {
  if (!v) return undefined
  return /^\d+$/.test(v) ? Number(v) : undefined
}
