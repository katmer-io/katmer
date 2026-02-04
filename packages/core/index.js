const { existsSync } = require("fs")
const { join } = require("path")

const { platform, arch } = process

/**
 * Prefer locally built artifacts (dev), then fall back to optional prebuilt packages.
 * This is intentionally resilient to @napi-rs/cli output naming differences.
 */
function loadNativeBinding() {
  const localCandidates = [
    join(__dirname, `katmer-core.${platform}-${arch}-msvc.node`),
    join(__dirname, `katmer-core.${platform}-${arch}-gnu.node`),
    join(__dirname, `katmer-core.${platform}-${arch}-musl.node`),
    join(__dirname, `katmer-core.${platform}-${arch}.node`),
    join(__dirname, `katmer-core.${platform}.node`),
    join(__dirname, "katmer-core.node"),
    join(__dirname, "index.node")
  ]

  for (const p of localCandidates) {
    if (!existsSync(p)) continue
    try {
      return require(p)
    } catch (e) {
      // keep trying other candidates
    }
  }

  const pkg = "@katmer/core"
  const prebuiltCandidates = [
    `${pkg}-${platform}-${arch}`,
    `${pkg}-${platform}-${arch}-msvc`,
    `${pkg}-${platform}-${arch}-gnu`,
    `${pkg}-${platform}-${arch}-musl`
  ]

  for (const name of prebuiltCandidates) {
    try {
      return require(name)
    } catch (e) {
      // keep trying
    }
  }

  const tried = localCandidates
    .concat(prebuiltCandidates)
    .map((x) => `- ${x}`)
    .join("\n")

  throw new Error(
    `Failed to load native binding for ${platform}-${arch}. Tried:\n${tried}`
  )
}

const native = loadNativeBinding()

class KatmerCore {
  constructor(opts = {}) {
    const normalized = { ...opts }
    if (typeof normalized.target === "string") {
      normalized.target = [normalized.target]
    }

    this._native = new native.NativeKatmerCore(normalized)
    this.logger = undefined
  }

  async init() {
    await this._native.loadConfig()
  }

  async loadConfig(config) {
    if (config === undefined) {
      await this._native.loadConfig()
      return
    }
    await this._native.loadConfig(JSON.stringify(config))
  }

  async check() {
    await this._native.check()
  }

  async run(file) {
    await this._native.run(file)
  }
}

module.exports = {
  ...native,
  KatmerCore,
  Katmer: {}
}
