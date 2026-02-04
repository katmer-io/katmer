import type { OsArch, OsFamily } from "./provider.interface"

export type PackageManager =
  | "apt"
  | "dnf"
  | "yum"
  | "zypper"
  | "apk"
  | "pacman"
  | "brew"
  | "port"
  | "choco"
  | "winget"
  | "unknown"

export interface PackageConstraint {
  /** Package name as seen by the package manager(s). */
  name: string
  /** Exact version (distro version string is OK), e.g. "1.5.2-1ubuntu1". */
  version?: string
  /**
   * Semver-like or comparator range, e.g. ">=1.5.0 <2".
   * If semver is not available, a simple comparator fallback is used.
   */
  range?: string
  /** One or more preferred package managers; omit to auto-detect. */
  manager?: PackageManager | PackageManager[]
  /**
   * Alternatives: any of these packages satisfying the constraints is acceptable.
   * Useful for cross-distro names (e.g., cron | cronie | dcron).
   */
  alternatives?: PackageConstraint[]
  /**
   * Optional custom test that returns 0 if installed and prints the version.
   * Example: `dpkg-query -W -f='${Version}' cron`
   */
  testCmd?: string
  /** When using testCmd, regex to extract the version from stdout (first capture group). */
  versionRegex?: string
}

export interface BinaryConstraint {
  /** Command to locate (e.g., "crontab", "bash", "powershell"). */
  cmd: string
  /** Optional args to run for version probe; default tries "--version" or "-V". */
  args?: string[]
  /** Regex to parse a version string from stdout/stderr (first capture group used). */
  versionRegex?: string | RegExp
  /** Version range to satisfy (same rules as PackageConstraint.range). */
  range?: string
  /** Alternatives: if any child passes, this binary constraint is satisfied. */
  or?: BinaryConstraint[]
}

export interface ModulePlatformConstraint {
  /** Supported architectures; default = ["any"]. */
  arch?: OsArch[]
  /** Family-level packages (before per-distro overrides). */
  packages?: Array<PackageConstraint | string>
  /** Required binaries/shells present in PATH. */
  binaries?: BinaryConstraint[]
  /** Require root (POSIX) or Administrator (Windows). */
  requireRoot?: boolean
  /** Optional minimal kernel version (POSIX) or OS version (Windows/macOS). */
  minKernel?: string // e.g., ">=4.15"
  minOsVersion?: string // e.g., ">=10.15" for macOS, ">=10.0" for Windows
  /**
   * Per-distro overrides/extensions. Keys are normalized IDs like:
   * "debian", "ubuntu", "rhel", "centos", "rocky", "fedora", "alpine",
   * "arch", "opensuse", "sles", "amzn", "amazon", or "any".
   */
  distro?: {
    [distroId: string]: true | false | Omit<ModulePlatformConstraint, "distro">
  }
}

/**
 * New constraints structure:
 * - platform is a map: any|linux|darwin|windows|freebsd|... → true|false|ModulePlatformConstraint
 * - Each platform may also have distro overrides.
 */
export interface ModuleConstraints {
  platform?: {
    [family in OsFamily | "any" | "local"]?:
      | true
      | false
      | ModulePlatformConstraint
  }
}

export type ModulePlatformConstraintLegacy = never // (kept only if you referenced it elsewhere)

export interface ModuleOptionsObject {
  [key: string]: any // allow provider-specific options
}
export type ModuleOptions = any

/**
 * Standard result shape returned by modules.
 *
 * @remarks
 * - `changed` indicates whether the module made any modifications on the target.
 * - `failed` flags an error condition; when `true`, execution is considered unsuccessful.
 * - `stdout`/`stderr` carry raw process output when applicable.
 * - Timing fields (`start`, `end`, `delta`) are best-effort and ISO8601 for start/end.
 * - `attempts`/`retries` are used by controls like `until` to report how many times an action ran.
 * - Extra module-specific keys are allowed via the index signature.
 *
 * @example
 * ```yaml
 * - name: fetch metadata
 *   register: meta
 *   http:
 *     url: "https://example.com/meta"
 *     fail_on_http_error: false
 *
 * - name: inspect result
 *   debug:
 *     vars:
 *       ok: "{{ not meta.failed }}"
 *       changed: "{{ meta.changed }}"
 *       status: "{{ meta.status }}"
 *       took: "{{ meta.delta }}"
 * ```
 *
 * @public
 */
export interface ModuleCommonReturn {
  /** Whether this module changed anything on the target. */
  changed?: boolean

  /** Whether the module failed (non-zero exit code, validation failure, etc.). */
  failed?: boolean

  /** Human-readable message describing the outcome or error. */
  msg?: string

  /** Captured standard output, if available. */
  stdout?: string

  /** Captured standard error, if available. */
  stderr?: string

  /** ISO8601 timestamp when execution started (best-effort). */
  start?: string

  /** ISO8601 timestamp when execution ended (best-effort). */
  end?: string

  /** Duration string, e.g., "0:00:00.123" (best-effort). */
  delta?: string

  /**
   * Number of attempts performed so far (e.g., by `until`).
   * Typically increments from 1 upwards.
   */
  attempts?: number

  /**
   * Maximum retries allowed for this operation (e.g., by `until`).
   * This reflects the configured ceiling, not the attempts taken.
   */
  retries?: number

  /**
   * Additional module-specific data.
   * Modules may extend the result with fields such as `status`, `url`, `dest`, etc.
   */
  [key: string]: unknown
}
