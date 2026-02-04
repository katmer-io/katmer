import {
  type ModuleCommonReturn,
  type ModuleConstraints
} from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { KatmerModule } from "../module"

/**
 * Unified package management module.
 *
 * @remarks
 * This module provides a **single, portable interface** for installing,
 * updating, or removing packages across different operating systems
 * and package managers.
 *
 * Supported package managers:
 *
 * - **Linux**: apt, dnf, yum, pacman, apk, zypper
 * - **macOS**: brew
 * - **Windows**: winget, choco
 *
 * The module automatically:
 * - Probes for available package managers
 * - Selects the most appropriate one
 *
 * @examples
 * ```yaml
 * - name: Install curl
 *   package:
 *     name: curl
 *
 * - name: Ensure git is removed
 *   package:
 *     name: git
 *     state: absent
 *
 * - name: Upgrade docker
 *   package:
 *     name: docker
 *     state: latest
 *
 * - name: Install multiple packages
 *   package:
 *     name:
 *       - curl
 *       - git
 *       - jq
 * ```
 */
export class PackageModule extends KatmerModule<
  PackageModuleOptions,
  PackageModuleResult
> {
  static name = "package" as const

  constraints = {
    platform: {
      any: true
    }
  } satisfies ModuleConstraints

  async check(): Promise<void> {
    const o = normalizeOptions(this.params)
    if (!o.name || (Array.isArray(o.name) && o.name.length === 0)) {
      throw new Error("package: 'name' is required")
    }
  }

  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}

  async execute(ctx: Katmer.TaskContext): Promise<PackageModuleResult> {
    const o = normalizeOptions(this.params)
    const names = Array.isArray(o.name) ? o.name : [o.name]

    const pm = await detectPackageManager(ctx)
    if (!pm) {
      return {
        changed: false,
        failed: true,
        msg: "No supported package manager detected on target"
      }
    }

    const cmd = buildCommand(pm, o.state, names)
    if (!cmd) {
      return {
        changed: false,
        failed: true,
        msg: `Unsupported operation for package manager: ${pm}`
      }
    }

    const r = await ctx.execSafe(cmd)

    return {
      changed: r.code === 0,
      failed: r.code !== 0,
      stdout: r.stdout,
      stderr: r.stderr,
      manager: pm
    }
  }
}

/* ───────────────────────────────────────────────────────────── */
/* Options & Result Types                                        */
/* ───────────────────────────────────────────────────────────── */

/**
 * Options for the {@link PackageModule | `package`} module.
 *
 * @public
 */
export type PackageModuleOptions =
  | string
  | {
      /**
       * Package name or list of packages.
       */
      name: string | string[]

      /**
       * Desired state of the package(s).
       *
       * - `present`: ensure installed (default)
       * - `absent`: ensure removed
       * - `latest`: upgrade to latest version
       *
       * @defaultValue "present"
       */
      state?: "present" | "absent" | "latest"
    }

/**
 * Result returned by the {@link PackageModule | `package`} module.
 *
 * @public
 */
export interface PackageModuleResult extends ModuleCommonReturn {
  /** Package manager that was used */
  manager?: PackageManager
}

/* ───────────────────────────────────────────────────────────── */
/* Task context augmentation                                     */
/* ───────────────────────────────────────────────────────────── */

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      package?: PackageModuleOptions
    }
  }
}

/* ───────────────────────────────────────────────────────────── */
/* Internals                                                     */
/* ───────────────────────────────────────────────────────────── */

type PackageManager =
  | "apt"
  | "dnf"
  | "yum"
  | "pacman"
  | "apk"
  | "zypper"
  | "brew"
  | "winget"
  | "choco"

function normalizeOptions(p: PackageModuleOptions): {
  name: string | string[]
  state: "present" | "absent" | "latest"
} {
  if (typeof p === "string") {
    return { name: p, state: "present" }
  }
  return {
    name: p.name,
    state: p.state ?? "present"
  }
}

async function detectPackageManager(
  ctx: Katmer.TaskContext
): Promise<PackageManager | null> {
  const fam = ctx.provider.os.family

  const probes: Array<[PackageManager, string]> = []

  if (fam === "linux") {
    probes.push(
      ["apt", "command -v apt-get"],
      ["dnf", "command -v dnf"],
      ["yum", "command -v yum"],
      ["pacman", "command -v pacman"],
      ["apk", "command -v apk"],
      ["zypper", "command -v zypper"]
    )
  } else if (fam === "darwin") {
    probes.push(["brew", "command -v brew"])
  } else if (fam === "windows") {
    probes.push(["winget", "where winget"], ["choco", "where choco"])
  }

  for (const [pm, probe] of probes) {
    const r = await ctx.execSafe(probe)
    if (r.code === 0) return pm
  }

  return null
}

function buildCommand(
  pm: PackageManager,
  state: "present" | "absent" | "latest",
  pkgs: string[]
): string | null {
  const list = pkgs.join(" ")

  switch (pm) {
    case "apt":
      if (state === "present")
        return `apt-get update -y && apt-get install -y ${list}`
      if (state === "latest")
        return `apt-get update -y && apt-get install -y --only-upgrade ${list}`
      return `apt-get remove -y ${list}`

    case "dnf":
      return (
        state === "absent" ? `dnf remove -y ${list}`
        : state === "latest" ? `dnf upgrade -y ${list}`
        : `dnf install -y ${list}`
      )

    case "yum":
      return (
        state === "absent" ? `yum remove -y ${list}`
        : state === "latest" ? `yum update -y ${list}`
        : `yum install -y ${list}`
      )

    case "pacman":
      return state === "absent" ?
          `pacman -R --noconfirm ${list}`
        : `pacman -S --noconfirm ${list}`

    case "apk":
      return state === "absent" ? `apk del ${list}` : `apk add ${list}`

    case "zypper":
      return state === "absent" ?
          `zypper remove -y ${list}`
        : `zypper install -y ${list}`

    case "brew":
      return (
        state === "absent" ? `brew uninstall ${list}`
        : state === "latest" ? `brew upgrade ${list}`
        : `brew install ${list}`
      )

    case "winget":
      return (
        state === "absent" ? `winget uninstall --silent ${list}`
        : state === "latest" ? `winget upgrade --silent ${list}`
        : `winget install --silent ${list}`
      )

    case "choco":
      return (
        state === "absent" ? `choco uninstall -y ${list}`
        : state === "latest" ? `choco upgrade -y ${list}`
        : `choco install -y ${list}`
      )

    default:
      return null
  }
}
