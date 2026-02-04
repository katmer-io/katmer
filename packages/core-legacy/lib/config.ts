import configSchema from "./schemas/katmer_config.schema.json" with { type: "json" }

import Ajv from "ajv/dist/2020"
import ajvErrors from "ajv-errors"
import { toMerged } from "es-toolkit"

import { parseKatmerFile, readKatmerFile } from "./utils/file.utils"
import { wrapInArray } from "./utils/json.utils"
import { HttpModule } from "./modules/http/http.local.module"
import { LocalProvider } from "./providers/local.provider"
import { normalizeAjvError } from "./utils/ajv.utils"
import type { KatmerConfig } from "./interfaces/config.interface"

const ajv = ajvErrors(
  new Ajv({
    allErrors: true,
    allowMatchingProperties: true,
    allowUnionTypes: true
  }),
  {
    singleError: false
  }
).addSchema(configSchema)

export const KatmerConfigLoader = {
  async load(
    target: string | object | (string | object)[],
    opts?: {
      cwd?: string
    }
  ): Promise<KatmerConfig> {
    const configTargets = wrapInArray(target)
    const cwd = opts?.cwd || process.cwd()

    let config = {} as KatmerConfig

    for (const configTarget of configTargets) {
      let loadedConfig: Record<string, any> = {}
      if (typeof configTarget === "string") {
        const parsed = await readKatmerFile(configTarget, {
          cwd,
          process: false,
          errorMessage: `Failed to load config file from: ${configTarget}`
        })
        loadedConfig = this.validate(parsed, configTarget)
      } else {
        const fetch = new HttpModule(configTarget as any, new LocalProvider({}))
        const { body, url } = await fetch.execute({} as any)

        const filename = `${url.origin}${url.pathname}`
        loadedConfig = this.validate(
          await parseKatmerFile(filename, body),
          filename
        )
      }

      if (loadedConfig.include) {
        loadedConfig = toMerged(
          loadedConfig,
          await KatmerConfigLoader.load(loadedConfig.include, opts)
        )
      }
      loadedConfig.include = undefined
      config = toMerged(config, loadedConfig)
    }
    config.cwd = opts?.cwd || process.cwd()
    return config
  },
  validate(obj: any, filename?: string) {
    const configValidator = ajv.getSchema(
      "https://katmer.dev/schemas/katmer-config.schema.json"
    )!
    configValidator(obj)
    if (configValidator.errors) {
      const err = configValidator.errors[0]
      throw new Error(
        `Invalid configuration${filename ? ` [${filename}]` : ""}: ${normalizeAjvError(err)} at path: ${err.instancePath}`
      )
    }
    return obj
  }
}
