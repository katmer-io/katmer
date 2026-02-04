import type {
  KatmerConfig,
  KatmerHostResolved,
  KatmerHostInput
} from "./interfaces/config.interface"
import { toMerged } from "es-toolkit"
import type { KatmerProvider } from "./interfaces/provider.interface"
import objectHash from "stable-hash"
import { SSHProvider } from "./providers/ssh/ssh.provider"
import type { KatmerCore } from "./katmer"
import { LocalProvider } from "./providers/local.provider"
import { wildcardMatch } from "./utils/string.utils"
import { evalObjectVals, evalTemplate } from "./utils/renderer/renderer"

export class KatmerTargetResolver {
  #providerCache = new Map<string, KatmerProvider>()

  #allNames: Set<string>
  #groups: Map<string, Set<string>>
  #hosts: Map<string, KatmerHostResolved>
  constructor(
    private core: KatmerCore,
    ...targets: KatmerConfig["targets"][]
  ) {
    const normalized = KatmerTargetResolver.normalizeHosts(
      this.core.config.targets,
      ...targets
    )
    this.#hosts = normalized.hosts
    this.#groups = normalized.groups
    this.#allNames = normalized.allNames
  }

  get hosts() {
    return this.#hosts
  }

  async resolveProvider(opts: KatmerHostResolved): Promise<KatmerProvider> {
    const key = objectHash(opts)

    if (this.#providerCache.has(key)) {
      return this.#providerCache.get(key)!
    }
    let provider: KatmerProvider
    if (!opts.connection || opts.connection === "ssh") {
      provider = new SSHProvider(opts)
    } else if (opts.connection === "local") {
      provider = new LocalProvider(opts)
    } else {
      throw new Error(`Unknown connection type: ${opts["connection"]}`)
    }

    provider.logger = this.core.logger.child({
      provider: provider.constructor.name
    })

    if (opts.variables) {
      provider.variables = toMerged(provider.variables, opts.variables)
    }
    if (opts.environment) {
      const env = toMerged(provider.environment, opts.environment)

      provider.environment = await evalObjectVals(env, {
        //   TODO: env context
      })
    }

    this.#providerCache.set(key, provider)
    return provider
  }

  resolveTargets(pattern: string) {
    if (pattern === "all" || pattern === "*") {
      return [...this.#hosts.values()]
    }

    const parts = pattern.split(/[:,]/)
    const included = [] as string[]
    const excluded = [] as string[]
    const intersected = [] as string[]

    for (const part of parts) {
      if (part.startsWith("!")) {
        const plainName = part.slice(1)
        if (excluded.indexOf(plainName) === -1) {
          excluded.push(plainName)
        }
      } else if (part.startsWith("@")) {
        const plainName = part.slice(1)
        if (intersected.indexOf(plainName) === -1) {
          intersected.push(part.slice(1))
        }
      } else if (included.indexOf(part) === -1) {
        const token = part === "all" ? "*" : part // ← normalize 'all'
        if (!included.includes(token)) included.push(token)
      }
    }
    const wildcard = (name: string, pat: string) => wildcardMatch(name, pat)
    const matchesAny = (name: string, list: string[]) =>
      list.some((p) => wildcard(name, p))
    const isExcluded = (name: string) => excluded.some((p) => wildcard(name, p))

    // Stage 1: choose label candidates (hosts or groups), honoring exclusion
    const candidateLabels = new Set<string>()
    for (const name of this.#allNames) {
      if (isExcluded(name)) continue
      if (included.length === 0 || matchesAny(name, included)) {
        candidateLabels.add(name)
      }
    }

    // Stage 2: expand labels to hostnames, honoring exclusion & dedupe
    const expandedHostnames = new Set<string>()
    for (const label of candidateLabels) {
      if (this.#groups.has(label)) {
        for (const host of this.#groups.get(label)!) {
          if (!isExcluded(host)) expandedHostnames.add(host)
        }
      } else if (this.#hosts.has(label)) {
        if (!isExcluded(label)) expandedHostnames.add(label)
      }
    }

    // Stage 3: optional intersection (@foo) applied on final hostnames
    let finalHostnames = Array.from(expandedHostnames)
    if (intersected.length > 0) {
      finalHostnames = finalHostnames.filter((h) => matchesAny(h, intersected))
    }

    const resolved = finalHostnames
      .map((h) => this.#hosts.get(h)!)
      .filter(Boolean)

    if (resolved.length === 0) {
      throw new Error(`No targets found for pattern: ${pattern}`)
    }
    return resolved
  }

  static normalizeHosts(...inputs: KatmerConfig["targets"][]) {
    const reservedKeys = [
      "all",
      "children",
      "settings",
      "variables",
      "environment",
      "hosts"
    ]
    const allNames = new Set<string>()
    const hosts = new Map<string, KatmerHostResolved>()
    const groups = new Map<string, Set<string>>()

    const groupSettingsAccum = new Map<string, Record<string, any>>()
    const groupVariablesAccum = new Map<string, Record<string, any>>()
    const groupEnvAccum = new Map<string, Record<string, any>>() // NEW

    for (const input of inputs) {
      if (!input) continue

      const rootKeys = Object.keys(input)
      const isHostsDef =
        rootKeys.includes("hosts") ||
        rootKeys.includes("settings") ||
        rootKeys.includes("variables") ||
        rootKeys.includes("environment") // NEW

      if (isHostsDef) {
        // Ungrouped (root) settings
        const incomingSettings = (input as any).settings || {}
        const prevSettings = groupSettingsAccum.get("ungrouped") || {}
        const effSettings = toMerged(prevSettings, incomingSettings) as any
        groupSettingsAccum.set("ungrouped", effSettings)

        // Ungrouped variables
        const incomingVars = (input as any).variables || {}
        const prevVars = groupVariablesAccum.get("ungrouped") || {}
        const effVars = toMerged(prevVars, incomingVars) as any
        groupVariablesAccum.set("ungrouped", effVars)

        // Ungrouped environment (NEW)
        const incomingEnv = (input as any).environment || {}
        const prevEnv = groupEnvAccum.get("ungrouped") || {}
        const effEnv = toMerged(prevEnv, incomingEnv) as any
        groupEnvAccum.set("ungrouped", effEnv)

        processHostEntries(
          (input as any).hosts,
          "ungrouped",
          effSettings,
          effVars,
          effEnv
        )
      } else {
        for (const [groupName, def] of Object.entries(input)) {
          if (reservedKeys.includes(groupName)) {
            throw `cannot use '${groupName}' as group name: it is a reserved keyword`
          }

          // Group settings
          const incomingSettings = (def as any)?.settings || {}
          const prevSettings = groupSettingsAccum.get(groupName) || {}
          const effSettings = toMerged(prevSettings, incomingSettings) as any
          groupSettingsAccum.set(groupName, effSettings)

          // Group variables
          const incomingVars = (def as any)?.variables || {}
          const prevVars = groupVariablesAccum.get(groupName) || {}
          const effVars = toMerged(prevVars, incomingVars) as any
          groupVariablesAccum.set(groupName, effVars)

          // Group environment (NEW)
          const incomingEnv = (def as any)?.environment || {}
          const prevEnv = groupEnvAccum.get(groupName) || {}
          const effEnv = toMerged(prevEnv, incomingEnv) as any
          groupEnvAccum.set(groupName, effEnv)

          processHostEntries(
            def?.hosts,
            groupName,
            effSettings,
            effVars,
            effEnv
          )

          // Link children: inherit parent *settings/variables/environment* to child hosts
          const childNames = Object.keys(def?.children || {})
          for (const childGroupName of childNames) {
            if (!groups.has(childGroupName)) {
              throw `child group not found: '${childGroupName}' in group: '${groupName}'`
            }
            for (const child_hostname of groups.get(childGroupName)!) {
              const prevChild = (hosts.get(child_hostname) || {}) as any
              const childVarsPrev = prevChild.variables || {}
              const childEnvPrev = prevChild.environment || {}
              const parentVars = groupVariablesAccum.get(groupName) || {}
              const parentEnv = groupEnvAccum.get(groupName) || {}

              hosts.set(child_hostname, {
                ...(toMerged(prevChild, effSettings) as any),
                name: child_hostname,
                variables: toMerged(childVarsPrev, parentVars),
                environment: toMerged(childEnvPrev, parentEnv) // NEW
              })
            }
          }
        }
      }
    }

    function processHostEntries(
      hostConfig?: Record<string, KatmerHostInput>,
      groupName: string = "ungrouped",
      groupSettings: Record<string, any> = {},
      groupVariables: Record<string, any> = {},
      groupEnvironment: Record<string, any> = {} // NEW
    ) {
      if (!groups.has(groupName)) groups.set(groupName, new Set<string>())
      const groupHosts = groups.get(groupName)!
      allNames.add(groupName)

      for (const [hostname, host_settings] of Object.entries(
        hostConfig || {}
      )) {
        if (reservedKeys.includes(hostname)) {
          throw `cannot use '${hostname}' as hostname: it is a reserved keyword`
        }
        allNames.add(hostname)
        groupHosts.add(hostname)

        const prev = (hosts.get(hostname) || {}) as any
        const mergedConn = toMerged(
          prev,
          toMerged(groupSettings || {}, host_settings || {})
        ) as any

        const prevVars = prev.variables || {}
        const prevEnv = prev.environment || {}

        hosts.set(hostname, {
          ...mergedConn,
          name: hostname,
          variables: toMerged(prevVars, groupVariables || {}),
          environment: toMerged(prevEnv, groupEnvironment || {}) // NEW
        })
      }
    }

    return { groups, hosts, allNames }
  }

  async [Symbol.asyncDispose]() {
    try {
      for (const [_hash, provider] of this.#providerCache.entries()) {
        await provider.safeShutdown()
      }
    } catch {}
  }
}
