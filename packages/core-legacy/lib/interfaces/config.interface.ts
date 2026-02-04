import pino from "pino"

export interface KatmerCLIOptions {
  cwd?: string
  target: string[]
}
// Connection variants
export interface SSHConfig {
  connection: "ssh"
  hostname: string
  port?: number
  username?: string
  password?: string
  private_key?: string
  private_key_password?: string
  [k: string]: unknown
}

export interface LocalConfig {
  connection: "local"
  [k: string]: unknown
}

export type KatmerHostInput = SSHConfig | LocalConfig

export type KatmerHostResolved = (SSHConfig | LocalConfig) & {
  name: string
  variables?: Record<string, unknown>
  environment?: Record<string, string>
}

// Reserved labels
export type KatmerReservedKey =
  | "all"
  | "children"
  | "settings"
  | "hosts"
  | "variables"

// Group settings (anything mergeable; no required `connection`)
export type KatmerGroupSettings = {
  [k: string]: unknown
} & Partial<
  Omit<SSHConfig, "connection" | "hostname"> & Omit<LocalConfig, "connection">
>

export type KatmerGroupVariables = Record<string, unknown>
export type KatmerGroupEnvironment = Record<string, unknown>

// Strict host map for the **root** form
export type KatmerHostsRoot = Record<string, KatmerHostInput>

// Shorthand-friendly host map for **groups** (allows `{}` etc.)
export type KatmerHostShorthand = Partial<KatmerHostInput>
export type KatmerHostsInGroup = Record<string, KatmerHostShorthand>

// Children reference map
export type KatmerChildren = Record<string, {} | undefined>

// A single group
export interface KatmerGroup {
  children?: KatmerChildren
  hosts?: KatmerHostsInGroup
  settings?: KatmerGroupSettings // ← accepts {}
  variables?: KatmerGroupVariables
  environment?: KatmerGroupEnvironment
}

// Root “hosts/settings” form (implicit 'ungrouped')
export interface KatmerTargetsRootForm {
  hosts: KatmerHostsRoot // ← strict here
  settings?: KatmerGroupSettings
  variables?: KatmerGroupVariables
  environment?: KatmerGroupEnvironment
}

// Grouped form (forbid reserved top-level keys here)
export type KatmerTargetsGroupedForm = Record<string, KatmerGroup> & {
  all?: never
  children?: never
  hosts?: never
  settings?: never
  variables?: never
}

// Top-level targets
export type KatmerTargets = KatmerTargetsRootForm | KatmerTargetsGroupedForm

export interface KatmerConfig {
  cwd?: string
  logging?: {
    dir?: string
    level?: "trace" | "debug" | "info" | "warn" | "error" | "silent"
  }
  targets: KatmerTargets
}

// Optional: normalizer output helpers
export interface KatmerNormalizedTargets {
  groups: Map<string, Set<string>>
  hosts: Map<string, KatmerHostResolved>
  allNames: Set<string>
}

export interface StandardLogger {
  trace: pino.LogFn
  debug: pino.LogFn
  info: pino.LogFn
  warn: pino.LogFn
  error: pino.LogFn
  fatal: pino.LogFn
  child: (bindings: Record<string, unknown>) => StandardLogger
}
