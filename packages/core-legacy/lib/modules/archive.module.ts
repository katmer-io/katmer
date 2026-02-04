import { type ModuleCommonReturn } from "../interfaces/module.interface"
import type { Katmer } from "../interfaces/task.interface"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { KatmerModule } from "../module"

declare module "../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      archive?: ArchiveModuleOptions
    }
  }
}
/**
 * Archive/create/extract/list files using the system tar on all OSes.
 *
 * @remarks
 * - Supports formats: tar, tar.gz, tar.bz2, tar.xz, tar.zst, zip (via bsdtar).
 * - Works on SSHProvider and LocalProvider.
 * - Matches flags available in bsdtar(1) with sensible defaults.
 *
 * @examples
 * ```yaml
 * - name: Create a gzip archive
 *   archive:
 *     path:
 *       - /var/log
 *       - /etc/nginx
 *     dest: /tmp/system.tar.gz
 *     gzip: true
 *     verbose: true
 *
 * - name: Extract with strip components
 *   archive:
 *     src: /tmp/release.tar.gz
 *     dest: /opt/app
 *     strip_components: 1
 *
 * - name: List archive contents
 *   archive:
 *     src: /tmp/archive.tar.xz
 *     list: true
 * ```
 */
export class ArchiveModule extends KatmerModule<
  ArchiveModuleOptions,
  ArchiveModuleResult,
  KatmerProvider
> {
  static name = "archive" as const

  constraints = {
    platform: { any: { packages: ["tar"] } }
  }

  async check(): Promise<void> {
    const p = this.params
    if (!p) throw new Error("archive: options are required")
    if (!p.src && !p.path)
      throw new Error("archive: one of 'src' or 'path' is required")
    if (!p.dest && !p.list && !p.options)
      throw new Error(
        "archive: 'dest' is required unless listing or raw options"
      )
  }

  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}

  async execute(ctx: Katmer.TaskContext): Promise<ArchiveModuleResult> {
    const p = normalizeOptions(this.params)
    const sh = (v: string) => JSON.stringify(v)

    const tarCmd = await this.detectTar(ctx)

    // Build args
    const args: string[] = []

    // Determine mode
    if (p.list) args.push("-t")
    else if (p.src) args.push("-x")
    else args.push("-c")

    // Verbose
    if (p.verbose) args.push("-v")

    // Compression
    if (p.gzip) args.push("--gzip")
    if (p.bzip2) args.push("--bzip2")
    if (p.xz) args.push("--xz")
    if (p.zstd) args.push("--zstd")

    // Archive file
    const archiveArg = p.src ?? p.dest
    if (archiveArg) args.push("-f", sh(archiveArg))

    // Directory change before action
    if (p.chdir) args.push("-C", sh(p.chdir))

    // Creation paths
    if (p.path && !p.src) {
      const list = Array.isArray(p.path) ? p.path : [p.path]
      for (const item of list) args.push(sh(item))
    }

    // Filter flags
    if (p.strip_components != null)
      args.push(`--strip-components=${p.strip_components}`)

    if (p.exclude) for (const ex of p.exclude) args.push(`--exclude=${sh(ex)}`)

    // Ownership/Permission
    if (p.numeric_owner) args.push("--numeric-owner")
    if (p.uid != null) args.push(`--uid=${p.uid}`)
    if (p.gid != null) args.push(`--gid=${p.gid}`)

    if (p.preserve_permissions) args.push("--preserve-permissions")
    if (p.no_same_owner) args.push("--no-same-owner")
    if (p.no_same_permissions) args.push("--no-same-permissions")

    // Raw extra options
    if (p.options) args.push(...p.options)

    // Final command
    const cmd = `${tarCmd} ${args.join(" ")}`

    const r = await ctx.exec(cmd)

    return {
      changed: !p.list,
      failed: r.code !== 0,
      stdout: r.stdout,
      stderr: r.stderr,
      dest: p.dest
    }
  }

  private async detectTar(ctx: Katmer.TaskContext): Promise<string> {
    // Try bsdtar first, then tar
    const bins = ["tar", "tar.exe"]
    for (const b of bins) {
      try {
        await ctx.exec(`${b} --version`)
        return b
      } catch {
        /* ignore */
      }
    }
    throw new Error("archive: neither bsdtar nor tar was found on target")
  }
}

/**
 * Options for the {@link ArchiveModule | `archive`} module.
 *
 * @public
 */
export interface ArchiveModuleOptions {
  /**
   * Archive file to extract or list
   */
  src?: string

  /**
   * Destination directory (where to extract or where the created archive is saved)
   */
  dest?: string

  /**
   * Path(s) to include when creating an archive
   */
  path?: string | string[]

  /**
   * Change to this directory before running tar (`-C`)
   */
  chdir?: string

  /**
   * When true, list archive contents instead of extract/create
   */
  list?: boolean

  /**
   * Compression options (mutually exclusive)
   */
  gzip?: boolean
  bzip2?: boolean
  xz?: boolean
  zstd?: boolean

  /**
   * Strip leading path components on extract
   */
  strip_components?: number

  /**
   * Exclude patterns (glob-like)
   */
  exclude?: string[]

  /**
   * Preserve permissions on extract
   */
  preserve_permissions?: boolean

  /**
   * Don’t restore owner on extract
   */
  no_same_owner?: boolean

  /**
   * Don’t restore permissions on extract
   */
  no_same_permissions?: boolean

  /**
   * When true, use numeric owner/gid
   */
  numeric_owner?: boolean

  /**
   * Force a specific uid on extract
   */
  uid?: number

  /**
   * Force a specific gid on extract
   */
  gid?: number

  /**
   * Verbose output (`-v`)
   */
  verbose?: boolean

  /**
   * Extra raw flags passed directly to tar (after bsdtar detection)
   */
  options?: string[]
}

/**
 * Result of the archive operation.
 *
 * @public
 */
export interface ArchiveModuleResult extends ModuleCommonReturn {
  /**
   * Destination directory or archive path that was acted upon
   */
  dest?: string
}

/* normalize and defaults */
function normalizeOptions(opts: ArchiveModuleOptions): ArchiveModuleOptions {
  return {
    ...opts,
    list: opts.list ?? false,
    gzip: opts.gzip ?? false,
    bzip2: opts.bzip2 ?? false,
    xz: opts.xz ?? false,
    zstd: opts.zstd ?? false,
    strip_components: opts.strip_components ?? 0,
    exclude: opts.exclude ?? [],
    preserve_permissions: opts.preserve_permissions ?? false,
    no_same_owner: opts.no_same_owner ?? false,
    no_same_permissions: opts.no_same_permissions ?? false,
    numeric_owner: opts.numeric_owner ?? false,
    uid: opts.uid ?? undefined,
    gid: opts.gid ?? undefined,
    verbose: opts.verbose ?? false,
    options: opts.options ?? []
  }
}
