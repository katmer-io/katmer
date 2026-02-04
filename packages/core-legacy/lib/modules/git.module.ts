import fs from "fs-extra"
import git from "isomorphic-git"
import http from "isomorphic-git/http/node"
import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { SSHProvider } from "../providers/ssh/ssh.provider"
import { LocalProvider } from "../providers/local.provider"
import { KatmerModule } from "../module"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      git?: GitModuleOptions
    }
  }
}
/**
 * Manage Git checkouts on the target machine.
 *
 * @remarks
 * This module is inspired by **Ansible's `ansible.builtin.git`** module.
 *
 * Provider behavior:
 * - **Local provider**:
 *   - Uses {@link https://isomorphic-git.org | isomorphic-git}
 *   - Does NOT require system `git`
 *   - Ideal for controller-side checkouts and reproducible environments
 *
 * - **SSH provider**:
 *   - Uses system-installed `git` on the target host
 *   - Supports Linux, macOS, and Windows (`git.exe`)
 *   - Honors `become` and shell handling via provider
 *
 * Idempotency:
 * - `changed=false` when the repository is already at the desired revision
 * - `changed=true` on clone, checkout, pull, or reset
 *
 * @examples
 * Clone a repository:
 * ```yaml
 * - name: Clone repo
 *   git:
 *     repo: https://github.com/org/project.git
 *     dest: /opt/project
 * ```
 *
 * Checkout a specific tag:
 * ```yaml
 * - name: Checkout release
 *   git:
 *     repo: https://github.com/org/project.git
 *     dest: /srv/app
 *     version: v1.4.2
 * ```
 *
 * Force reset to main:
 * ```yaml
 * - name: Force sync
 *   git:
 *     repo: git@github.com:org/app.git
 *     dest: /srv/app
 *     version: main
 *     force: true
 * ```
 */
export class GitModule extends KatmerModule<
  GitModuleOptions,
  GitModuleResult,
  KatmerProvider
> {
  static name = "git" as const

  constraints = {
    platform: {
      local: true,
      any: { packages: ["git"] }
    }
  } satisfies ModuleConstraints

  async check(): Promise<void> {
    if (!this.params?.repo) throw new Error("git: 'repo' is required")
    if (!this.params?.dest) throw new Error("git: 'dest' is required")
  }

  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}

  async execute(ctx: Katmer.TaskContext): Promise<GitModuleResult> {
    const p = normalizeOptions(this.params)

    if (ctx.provider instanceof LocalProvider) {
      return this.runLocal(ctx, p)
    }

    if (ctx.provider instanceof SSHProvider) {
      return this.runSsh(ctx as Katmer.TaskContext<SSHProvider>, p)
    }

    return {
      changed: false,
      failed: true,
      msg: `git: unsupported provider ${ctx.provider?.constructor?.name}`
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────
  // Local (isomorphic-git)
  // ────────────────────────────────────────────────────────────────────────────────

  private async runLocal(
    _ctx: Katmer.TaskContext<LocalProvider>,
    p: NormalizedGitOptions
  ): Promise<GitModuleResult> {
    const exists = await fs.pathExists(p.dest)
    let changed = false

    if (!exists) {
      await git.clone({
        fs,
        http,
        dir: p.dest,
        url: p.repo,
        ref: p.version,
        depth: p.depth
      })
      changed = true
    } else {
      const head = await git.resolveRef({ fs, dir: p.dest, ref: "HEAD" })
      await git.fetch({ fs, http, dir: p.dest, ref: p.version })
      await git.checkout({ fs, dir: p.dest, ref: p.version })
      const newHead = await git.resolveRef({ fs, dir: p.dest, ref: "HEAD" })
      if (head !== newHead) changed = true
    }

    return {
      changed,
      failed: false,
      revision: await git.resolveRef({ fs, dir: p.dest, ref: "HEAD" })
    }
  }

  // ────────────────────────────────────────────────────────────────────────────────
  // SSH (system git)
  // ────────────────────────────────────────────────────────────────────────────────

  private async runSsh(
    ctx: Katmer.TaskContext<SSHProvider>,
    p: NormalizedGitOptions
  ): Promise<GitModuleResult> {
    const sh = ctx.provider.os.family === "windows" ? "" : "set -e; "
    const q = (s: string) => JSON.stringify(s)

    const exists = await ctx.execSafe(`${sh} test -d ${q(p.dest)}/.git`)

    let changed = false

    if (exists.code !== 0) {
      await ctx.exec(
        `${sh} git clone ${p.depth ? `--depth ${p.depth}` : ""} ${q(
          p.repo
        )} ${q(p.dest)}`
      )
      changed = true
    }

    const revBefore = await ctx.execSafe(
      `${sh} git -C ${q(p.dest)} rev-parse HEAD`
    )

    if (p.force) {
      await ctx.exec(
        `${sh} git -C ${q(p.dest)} fetch --all && git -C ${q(
          p.dest
        )} reset --hard ${q(p.version || "")}`
      )
      changed = true
    } else {
      await ctx.exec(`${sh} git -C ${q(p.dest)} fetch`)
      await ctx.exec(`${sh} git -C ${q(p.dest)} checkout ${q(p.version || "")}`)
    }

    const revAfter = await ctx.execSafe(
      `${sh} git -C ${q(p.dest)} rev-parse HEAD`
    )

    if (revBefore.stdout !== revAfter.stdout) changed = true

    return {
      changed,
      failed: false,
      revision: revAfter.stdout?.trim()
    }
  }
}

/* ───────────────────────── Types ───────────────────────── */

/**
 * Options for the {@link GitModule | `git`} module.
 *
 * @public
 */
export interface GitModuleOptions {
  /** Repository URL (HTTPS or SSH). */
  repo: string
  /** Destination directory on the target. */
  dest: string
  /** Branch, tag, or commit to checkout. */
  version?: string
  /** Force reset to the given version. */
  force?: boolean
  /** Create a shallow clone with the given depth. */
  depth?: number
}

/**
 * Result of the git operation.
 *
 * @public
 */
export interface GitModuleResult extends ModuleCommonReturn {
  /** Final commit hash after execution. */
  revision?: string
}

/* ───────────────────────── Internals ───────────────────────── */

type NormalizedGitOptions = Required<Pick<GitModuleOptions, "repo" | "dest">> &
  Omit<GitModuleOptions, "repo" | "dest">

function normalizeOptions(p: GitModuleOptions): NormalizedGitOptions {
  return {
    repo: p.repo,
    dest: p.dest,
    version: p.version ?? "HEAD",
    force: p.force ?? false,
    depth: p.depth
  }
}
