import { parseKatmerFile, readKatmerFile } from "./utils/file.utils"
import type {
  KatmerConfig,
  KatmerCLIOptions,
  StandardLogger
} from "./interfaces/config.interface"
import { KatmerTargetResolver } from "./target_resolver"
import "./module_registry"
import { KatmerModuleRegistry } from "./module_registry"
import * as pino from "pino"
import pinoPretty from "pino-pretty"
import { KatmerConfigLoader } from "./config"
import { evalExpr } from "./utils/renderer/renderer"
import type { ModuleCommonReturn } from "./interfaces/module.interface"
import { wrapInArray } from "./utils/json.utils"
import { defaults, isObjectLike } from "es-toolkit/compat"
import type { Katmer } from "./interfaces/task.interface"
import { KatmerTask } from "./task/task"

export interface KatmerInitOptions extends KatmerCLIOptions {
  logging?: {
    dir?: string
    level?: "trace" | "debug" | "info" | "warn" | "error" | "silent"
  }
}

export class KatmerCore {
  config!: KatmerConfig
  registry!: KatmerModuleRegistry
  logger!: StandardLogger
  constructor(private opts: KatmerCLIOptions) {}

  async init() {
    await this.loadConfig()
    this.initLogger()
    this.initRegistry()
  }

  async loadConfig(config?: Partial<KatmerConfig>) {
    if (config) {
      this.config = KatmerConfigLoader.validate(config)
    } else {
      const { target, cwd } = this.opts
      this.config = await KatmerConfigLoader.load(target, { cwd })
    }
  }

  initRegistry() {
    this.registry = new KatmerModuleRegistry(this)
  }

  initLogger() {
    this.logger = pino.pino(
      {
        formatters: {
          bindings() {
            return {}
          }
        },
        level: this.config.logging?.level || "trace",
        timestamp: pino.stdTimeFunctions.isoTime
      },
      pinoPretty({
        colorizeObjects: true,
        singleLine: false,
        useOnlyCustomProps: true,
        colorize: true,
        ignore: "provider,module",

        customPrettifiers: {
          command: (output, keyName, logObj, extras) => `${output}`,
          provider: (output, keyName, logObj, extras) => `${output}`,
          module: (output, keyName, logObj, extras) => `${output}`
        }
      })
    )
    // TODO: initialize logger
    // new ConsoleReadableStream().pipeTo(
    //   new WritableStream({
    //     write(log) {
    //       appendFile(logFile, `${JSON.stringify(log)}\n`)
    //       Bun.write(Bun.stdout, `${JSON.stringify(log)}\n`)
    //       for (const client of clients) {
    //         client.send(new WSMessage("log", log as any))
    //       }
    //     }
    //   })
    // )
  }
  async check() {
    await using targetResolver = new KatmerTargetResolver(this)
    const providers = targetResolver.resolveTargets("all")
    this.logger.debug({ hosts: targetResolver.hosts })
    this.logger.debug({ config: this.config, providers })
    for (const runFor of providers) {
      const provider = await targetResolver.resolveProvider(runFor)
      await provider.ensureReady()
    }
  }

  async run(file: string) {
    const contents = await readKatmerFile(file, {
      cwd: this.opts.cwd,
      errorMessage: "Failed to run task file"
    })
    await using targetResolver = new KatmerTargetResolver(
      this,
      contents.targets
    )
    const defaultOpts = contents.defaults || {}
    defaultOpts.targets = wrapInArray(defaultOpts.targets)

    const fileContext = {}

    for (const taskConfig of contents.tasks || []) {
      const task = new KatmerTask(this, targetResolver, taskConfig)

      await task.run(fileContext)
    }
  }
  async [Symbol.asyncDispose]() {
    return
  }
}

export type { Katmer } from "./interfaces/task.interface"
