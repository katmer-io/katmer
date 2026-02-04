import { describe, it, expect, beforeEach, vi } from "vitest"
import { SSHProvider } from "../lib/providers/ssh/ssh.provider"
import { LocalProvider } from "../lib/providers/local.provider"
import type {
  KatmerConfig,
  KatmerHostInput
} from "../lib/interfaces/config.interface"
import { KatmerTargetResolver } from "../lib/target_resolver"

vi.mock("../providers/ssh/ssh.provider", () => ({
  SSHProvider: vi.fn(
    class {
      constructor(public opts: any) {}
      type = "ssh"
      safeShutdown = vi.fn().mockResolvedValue(undefined)
    }
  )
}))

vi.mock("../providers/local.provider", () => ({
  LocalProvider: vi.fn(
    class {
      constructor(public opts: any) {}
      type = "local"
      safeShutdown = vi.fn().mockResolvedValue(undefined)
    }
  )
}))

function coreMock() {
  return {
    logger: {
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      })
    },
    config: { targets: {} }
  } as any
}

describe("KatmerTargetResolver", () => {
  let core: ReturnType<typeof coreMock>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetAllMocks()
    core = coreMock()
  })

  it("flattens root-level hosts/settings into the implicit 'ungrouped' group", () => {
    const input = {
      hosts: {
        a: { connection: "local" } as KatmerHostInput,
        b: { connection: "ssh", hostname: "10.0.0.2" } as KatmerHostInput
      },
      settings: { port: 22 }
    } as unknown as KatmerConfig["targets"]

    const r = KatmerTargetResolver.normalizeHosts(input)

    expect(r.groups.has("ungrouped")).toBe(true)
    expect(r.groups.get("ungrouped")?.has("a")).toBe(true)
    expect(r.groups.get("ungrouped")?.has("b")).toBe(true)
    expect(r.hosts.get("a")).toMatchObject({
      name: "a",
      connection: "local",
      port: 22
    })
    expect(r.hosts.get("b")).toMatchObject({
      name: "b",
      connection: "ssh",
      hostname: "10.0.0.2",
      port: 22
    })
  })

  it("merges group settings into hosts", () => {
    const input: KatmerConfig["targets"] = {
      group1: {
        settings: { port: 22 },
        hosts: {
          h1: { connection: "ssh", hostname: "10.0.0.1" } as KatmerHostInput
        }
      }
    }

    const r = KatmerTargetResolver.normalizeHosts(input)
    expect(r.hosts.get("h1")).toMatchObject({
      port: 22,
      hostname: "10.0.0.1",
      name: "h1"
    })
    expect(r.groups.get("group1")?.has("h1")).toBe(true)
  })

  it("applies parent settings to child groups' hosts via 'children' linkage", () => {
    const input: KatmerConfig["targets"] = {
      east: {
        settings: { port: 2201, region: "eu-east" },
        hosts: {
          h1: { connection: "ssh", hostname: "10.0.1.1" } as KatmerHostInput,
          h2: { connection: "ssh", hostname: "10.0.1.2" } as KatmerHostInput
        }
      },
      prod: {
        settings: { env: "prod", ssh_extra: true },
        children: {
          east: {} // include east into prod
        },
        hosts: {
          p1: { connection: "local" } as KatmerHostInput
        }
      }
    }

    const r = KatmerTargetResolver.normalizeHosts(input)

    // east group defined
    expect(r.groups.get("east")?.has("h1")).toBe(true)
    expect(r.groups.get("east")?.has("h2")).toBe(true)

    // prod group defined
    expect(r.groups.get("prod")?.has("p1")).toBe(true)

    // child inheritance: east hosts acquire prod settings as well
    expect(r.hosts.get("h1")).toMatchObject({
      port: 2201,
      region: "eu-east",
      env: "prod",
      ssh_extra: true
    })
    expect(r.hosts.get("h2")).toMatchObject({
      port: 2201,
      region: "eu-east",
      env: "prod",
      ssh_extra: true
    })

    // direct prod host has prod settings
    expect(r.hosts.get("p1")).toMatchObject({ env: "prod", ssh_extra: true })
  })

  it("overlays multiple inputs, merging by last-wins semantics", () => {
    const base: KatmerConfig["targets"] = {
      edge: {
        settings: { port: 22, os: "linux" },
        hosts: {
          n1: { connection: "ssh", hostname: "10.2.0.1", tags: ["a"] as any }
        }
      }
    }
    const overlay: KatmerConfig["targets"] = {
      edge: {
        settings: { os: "linux", ssh_key: "/id_rsa" },
        hosts: {
          n1: { username: "root", tags: ["b"] as any } as any,
          n2: { connection: "local" } as any
        }
      }
    }

    const r = KatmerTargetResolver.normalizeHosts(base, overlay)

    expect(r.groups.get("edge")?.has("n1")).toBe(true)
    expect(r.groups.get("edge")?.has("n2")).toBe(true)
    expect(r.hosts.get("n1")).toMatchObject({
      connection: "ssh",
      hostname: "10.2.0.1",
      username: "root",
      port: 22,
      os: "linux",
      ssh_key: "/id_rsa",
      tags: ["b"]
    })
    expect(r.hosts.get("n2")).toMatchObject({
      connection: "local",
      port: 22,
      os: "linux",
      ssh_key: "/id_rsa"
    })
  })

  it("rejects reserved keywords as group names", () => {
    const invalid = {
      all: {
        hosts: { h1: { connection: "ssh" } as KatmerHostInput }
      }
    }
    expect(() => KatmerTargetResolver.normalizeHosts(invalid as any)).toThrow()
  })

  it("rejects references to non-existent child groups", () => {
    const bad: KatmerConfig["targets"] = {
      west: {
        hosts: { w1: { connection: "local" } as KatmerHostInput }
      },
      prod: {
        children: {
          "not-a-group": {}
        }
      }
    }
    expect(() => KatmerTargetResolver.normalizeHosts(bad)).toThrow(
      /child group not found/i
    )
  })

  // ────────────────────────────────────────────────────────────────────────────────
  // VARIABLES & ENVIRONMENT MERGE BEHAVIOR
  // ────────────────────────────────────────────────────────────────────────────────

  it("flattens root-level variables/environment into 'ungrouped' hosts", () => {
    const input: KatmerConfig["targets"] = {
      hosts: {
        a: { connection: "local" } as KatmerHostInput,
        b: { connection: "ssh", hostname: "10.0.0.2" } as KatmerHostInput
      },
      variables: { env: "prod", app_dir: "/opt/app" } as any,
      environment: {
        NODE_ENV: "production",
        HTTP_PROXY: "http://proxy:8080"
      } as any
    } as any

    const r = KatmerTargetResolver.normalizeHosts(input)

    const a = r.hosts.get("a") as any
    const b = r.hosts.get("b") as any
    expect(a.variables).toMatchObject({ env: "prod", app_dir: "/opt/app" })
    expect(b.variables).toMatchObject({ env: "prod", app_dir: "/opt/app" })
    expect(a.environment).toMatchObject({
      NODE_ENV: "production",
      HTTP_PROXY: "http://proxy:8080"
    })
    expect(b.environment).toMatchObject({
      NODE_ENV: "production",
      HTTP_PROXY: "http://proxy:8080"
    })
  })

  it("merges group variables/environment into hosts", () => {
    const input: KatmerConfig["targets"] = {
      group1: {
        variables: { region: "eu", tier: "gold" } as any,
        environment: { NO_PROXY: "localhost,127.0.0.1" } as any,
        hosts: {
          h1: { connection: "ssh", hostname: "10.0.0.1" } as KatmerHostInput
        }
      }
    }

    const r = KatmerTargetResolver.normalizeHosts(input)
    const h1 = r.hosts.get("h1") as any

    expect(h1.variables).toMatchObject({ region: "eu", tier: "gold" })
    expect(h1.environment).toMatchObject({ NO_PROXY: "localhost,127.0.0.1" })
  })

  it("applies parent variables/environment to children", () => {
    const input: KatmerConfig["targets"] = {
      east: {
        variables: { region: "eu-east" } as any,
        environment: { NODE_ENV: "staging" } as any,
        hosts: {
          h1: { connection: "ssh", hostname: "10.0.1.1" } as KatmerHostInput
        }
      },
      prod: {
        variables: { env: "prod" } as any,
        environment: { HTTP_PROXY: "http://proxy:8080" } as any,
        children: { east: {} },
        hosts: { p1: { connection: "local" } as KatmerHostInput }
      }
    }

    const r = KatmerTargetResolver.normalizeHosts(input)
    const h1 = r.hosts.get("h1") as any
    const p1 = r.hosts.get("p1") as any

    // child (east) host inherits parent (prod) variables/environment
    expect(h1.variables).toMatchObject({ region: "eu-east", env: "prod" })
    expect(h1.environment).toMatchObject({
      NODE_ENV: "staging",
      HTTP_PROXY: "http://proxy:8080"
    })
    // direct prod host (p1) gets prod variables/environment
    expect(p1.variables).toMatchObject({ env: "prod" })
    expect(p1.environment).toMatchObject({ HTTP_PROXY: "http://proxy:8080" })
  })

  it("last-wins overlay for variables/environment across inputs", () => {
    const base: KatmerConfig["targets"] = {
      edge: {
        variables: { region: "eu", role: "edge", flags: { a: 1 } } as any,
        environment: { NODE_ENV: "staging", NO_PROXY: "localhost" } as any,
        hosts: {
          n1: { connection: "ssh", hostname: "10.2.0.1" } as KatmerHostInput
        }
      }
    }
    const overlay: KatmerConfig["targets"] = {
      edge: {
        variables: { region: "eu", role: "edge-v2", flags: { b: 2 } } as any,
        environment: { NODE_ENV: "production" } as any,
        hosts: {
          n1: { username: "root" } as any,
          n2: { connection: "local" } as any
        }
      }
    }

    const r = KatmerTargetResolver.normalizeHosts(base, overlay)
    const n1 = r.hosts.get("n1") as any
    const n2 = r.hosts.get("n2") as any

    // variables deep-merge last-wins
    expect(n1.variables).toMatchObject({
      region: "eu",
      role: "edge-v2",
      flags: { a: 1, b: 2 }
    })
    expect(n2.variables).toMatchObject({
      region: "eu",
      role: "edge-v2",
      flags: { a: 1, b: 2 }
    })

    // environment last-wins (simple merge)
    expect(n1.environment).toMatchObject({
      NODE_ENV: "production",
      NO_PROXY: "localhost"
    })
    expect(n2.environment).toMatchObject({
      NODE_ENV: "production",
      NO_PROXY: "localhost"
    })
  })

  // ────────────────────────────────────────────────────────────────────────────────
  // Pattern Matching & Selection (include, exclude, intersection, wildcards)
  // ────────────────────────────────────────────────────────────────────────────────

  it("selects hosts with 'all' (acts like '*')", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any,
          api_01: { connection: "local" } as any,
          api_02: { connection: "local" } as any
        }
      },
      east: { hosts: { host_1: {}, host_2: {} } },
      core: {
        hosts: {
          coreA: { connection: "ssh" } as any,
          coreB: { connection: "ssh" } as any
        }
      }
    }

    const resolver = new KatmerTargetResolver(coreMock(), cfg)
    const res = resolver.resolveTargets("all")
    expect(res.map((h) => h.name).sort()).toEqual(
      ["api_01", "api_02", "coreA", "coreB", "host_1", "host_2"].sort()
    )
  })

  it("includes by direct hostname", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      },
      east: { hosts: { host_1: {}, host_2: {} } }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("host_1")
    expect(res.map((h) => h.name)).toEqual(["host_1"])
  })

  it("supports wildcard includes", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          api_01: { connection: "local" } as any,
          api_02: { connection: "local" } as any,
          host_1: { connection: "ssh" } as any
        }
      }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("api_*")
    expect(res.map((h) => h.name).sort()).toEqual(["api_01", "api_02"].sort())
  })

  it("supports excluding hosts via '!pattern' (re-applied after group expansion)", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      },
      east: { hosts: { host_1: {}, host_2: {} } }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("*,!host_2")
    expect(res.every((h) => h.name !== "host_2")).toBe(true)

    const names = res.map((h) => h.name)
    expect(new Set(names).size).toBe(names.length) // deduped
  })

  it("selects a group by name", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      },
      east: { hosts: { host_1: {}, host_2: {} } }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("east")
    expect(res.map((h) => h.name).sort()).toEqual(["host_1", "host_2"].sort())
  })

  it("supports intersection with '@pattern' after includes", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      },
      east: { hosts: { host_1: {}, host_2: {} } }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("east,@host_1")
    expect(res.length).toBe(1)
    expect(res[0].name).toBe("host_1")
  })

  it("combines include group and exclude a single member", () => {
    const cfg: KatmerConfig["targets"] = {
      east: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("east,!host_2")
    expect(res.map((h) => h.name)).toEqual(["host_1"])
  })

  it("dedupes when a host is included via multiple paths (group + direct)", () => {
    const cfg: KatmerConfig["targets"] = {
      east: {
        hosts: {
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("east,host_1")
    const names = res.map((h) => h.name)
    expect(names).toContain("host_1")
    expect(new Set(names).size).toBe(names.length)
  })

  it("handles complex pattern: multiple includes, excludes, and intersection", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          api_01: { connection: "local" } as any,
          api_02: { connection: "local" } as any,
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      },
      east: { hosts: { host_1: {}, host_2: {} } },
      west: { hosts: { api_01: {}, api_02: {} } },
      core: {
        hosts: {
          coreA: { connection: "ssh" } as any,
          coreB: { connection: "ssh" } as any
        }
      }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("east,west,api_*,!core*,@api_0*")
    expect(res.map((h) => h.name).sort()).toEqual(["api_01", "api_02"].sort())
  })

  it("treats 'all' in patterns like '*' and allows exclusions (no short-circuit)", () => {
    const cfg: KatmerConfig["targets"] = {
      ungrouped: {
        hosts: {
          api_01: { connection: "local" } as any,
          api_02: { connection: "local" } as any,
          host_1: { connection: "ssh" } as any,
          host_2: { connection: "ssh" } as any
        }
      },
      core: {
        hosts: {
          coreA: { connection: "ssh" } as any,
          coreB: { connection: "ssh" } as any
        }
      }
    }
    const resolver = new KatmerTargetResolver(coreMock(), cfg)

    const res = resolver.resolveTargets("all,!core*")
    expect(res.map((h) => h.name).sort()).toEqual(
      ["api_01", "api_02", "host_1", "host_2"].sort()
    )
  })

  // ────────────────────────────────────────────────────────────────────────────────
  // Provider Lifecycle & Caching
  // ────────────────────────────────────────────────────────────────────────────────

  it("instantiates providers based on connection type and injects logger child", async () => {
    const resolver = new KatmerTargetResolver(core, {})

    const pSsh = await resolver.resolveProvider({ connection: "ssh" } as any)
    const pLocal = await resolver.resolveProvider({
      connection: "local"
    } as any)

    expect(pSsh.type).toBe("ssh")
    expect(pLocal.type).toBe("local")
    expect(SSHProvider).toHaveBeenCalledTimes(1)
    expect(LocalProvider).toHaveBeenCalledTimes(1)
    expect(core.logger.child).toHaveBeenCalledTimes(2)
  })

  it("caches providers by stable-hash of options", async () => {
    const resolver = new KatmerTargetResolver(core, {})
    const opts = { connection: "local", foo: "bar" } as any

    const p1 = await resolver.resolveProvider(opts)
    const p2 = await resolver.resolveProvider({
      connection: "local",
      foo: "bar"
    } as any)

    expect(p1).toBe(p2)
    expect(LocalProvider).toHaveBeenCalledTimes(1)
  })

  it("gracefully shuts down all cached providers on async dispose", async () => {
    const resolver = new KatmerTargetResolver(core, {})
    const p1 = await resolver.resolveProvider({
      connection: "ssh"
    } as any)
    const p2 = await resolver.resolveProvider({ connection: "local" } as any)

    await resolver[Symbol.asyncDispose]()

    expect(p1.safeShutdown).toHaveBeenCalled()
    expect(p2.safeShutdown).toHaveBeenCalled()
  })
})
