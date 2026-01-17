import type { Katmer } from "../katmer"
import { type KatmerCore } from "../katmer"
import type { KatmerTargetResolver } from "../target_resolver"
import { wrapInArray } from "../utils/json.utils"
import type { ModuleCommonReturn } from "../interfaces/module.interface"
import { omit, toMerged } from "es-toolkit"
import type { KatmerProvider } from "../interfaces/provider.interface"
import { TaskControlKeys, TaskControls } from "./controls"
import { msToDelta, nowIso } from "../utils/datetime.utils"
import {
  evalExpr,
  evalObjectVals,
  evalTemplate
} from "../utils/renderer/renderer"
import { merge } from "es-toolkit/compat"
import { TypedEventEmitter } from "../utils/typed-event-emitter"
import { AsyncLocalStorage } from "node:async_hooks"
import { cls } from "../utils/cls"
import { ExecutionFailedError, TaskExecutionFailedError } from "../utils/errors"
import type { KatmerModule } from "../module"

export class KatmerTask extends TypedEventEmitter<{
  "before:execute": [KatmerTask, Katmer.TaskContext]
  "module:check": [KatmerTask, Katmer.TaskContext, KatmerModule]
  "module:init": [KatmerTask, Katmer.TaskContext, KatmerModule]
  "module:execute": [
    KatmerTask,
    Katmer.TaskContext,
    KatmerModule,
    ModuleCommonReturn
  ]
  "after:execute": [KatmerTask, Katmer.TaskContext, ModuleCommonReturn]
}> {
  variables = {} as Record<string, any>
  modules = [] as [string, any][]
  targets: string[]

  constructor(
    public core: KatmerCore,
    public targetResolver: KatmerTargetResolver,
    public cfg: Katmer.Task
  ) {
    super()
    const taskModules = omit(cfg, [
      "name",
      "become",
      "targets",
      "variables",
      ...TaskControlKeys
    ])

    this.modules = this.normalizeModules(taskModules)

    // TODO: use better way for internal modules
    if (cfg.become) {
      this.modules.unshift(["become", cfg.become])
    }

    this.variables = cfg.variables || {}
    this.targets = wrapInArray(cfg.targets)

    for (const taskControl of TaskControls) {
      taskControl.register(this, cfg[taskControl.configKey] as any)
    }
  }

  async run(context: Record<string, any> = {}) {
    for (const target of this.targets) {
      const providers = this.targetResolver.resolveTargets(target)

      for (const runFor of providers) {
        const provider = await this.targetResolver.resolveProvider(runFor)
        await this.runForProvider(provider, context)
      }
    }
  }

  async runForProvider(
    provider: KatmerProvider,
    context: Record<string, any> = {}
  ) {
    await provider.ensureReady()
    const ctx = this.generateTaskContext(provider, context)
    return await cls.run(ctx, async () => {
      return await this.execute(ctx)
    })
  }

  async execute(ctx: Katmer.TaskContext) {
    this.emit("before:execute", this, ctx)

    let lastResult: any

    const modules = [] as KatmerModule[]
    for (const [moduleName, moduleParams] of this.modules) {
      modules.push(
        this.core.registry.get(moduleName, moduleParams) as KatmerModule
      )
    }

    for (const module of modules) {
      await module.doCheck(ctx)
      this.emit("module:check", this, ctx, module)

      ctx.logger.trace(`Initializing module`)
      await module.doInitialize?.(ctx)
      this.emit("module:init", this, ctx, module)

      ctx.logger.trace(`Executing module`)

      // Per-module timing
      const startAt = Date.now()
      const startIso = nowIso()

      try {
        const res = await module.doExecute(ctx)
        const endAt = Date.now()
        const endIso = nowIso()

        // Ensure ModuleCommonReturn core fields are present if missing
        if (res.changed === undefined) res.changed = false
        if (res.failed === undefined) res.failed = false

        if (!res.start) res.start = startIso
        if (!res.end) res.end = endIso
        if (!res.delta) {
          // If module supplied start/end, honor them; otherwise compute
          const started = Date.parse(res.start || startIso) || startAt
          const ended = Date.parse(res.end || endIso) || endAt
          res.delta = msToDelta(ended - started)
        }

        lastResult = res
      } catch (err: any) {
        const endAt = Date.now()
        const endIso = nowIso()

        // Convert thrown error into ModuleCommonReturn shape
        lastResult = {
          changed: false,
          failed: true,
          msg:
            typeof err === "string" ? err : (
              err?.message || err?.msg || "Task failed"
            ),
          stdout: err?.stdout,
          stderr: err?.stderr,
          start: startIso,
          end: endIso,
          delta: msToDelta(endAt - startAt)
        }
        // Stop at the first failure (keeps current behavior of bubbling errors)
        break
      } finally {
        this.emit("module:execute", this, ctx, module, lastResult)
      }
    }

    if (lastResult.failed) {
      throw new TaskExecutionFailedError(this, lastResult)
    } else {
      ctx.logger.info({ msg: "Task finished", result: lastResult })
    }

    this.emit("after:execute", this, ctx, lastResult)
    return lastResult
  }

  protected normalizeModules(modules: Record<string, unknown>) {
    const registered = [] as [string, any][]

    const moduleEntries = Object.entries(modules)
    if (moduleEntries.length === 0) {
      throw new Error("No modules encountered in the task")
    }
    if (moduleEntries.length > 1) {
      throw new Error("Only one module is allowed in the task")
    }

    const [moduleName, moduleParams] = moduleEntries[0]
    if (this.core.registry.has(moduleName)) {
      registered.push([moduleName, moduleParams])
    } else {
      throw new Error(`Unknown module encountered: ${moduleName}`)
    }
    return registered
  }

  generateTaskContext<Provider extends KatmerProvider>(
    provider: Provider,
    context: Record<string, any> = {}
  ): Katmer.TaskContext<Provider> {
    const logger = provider.logger.child({ task: this.cfg.name || "" })

    return {
      config: this.core.config,
      exec: provider.executor(),
      async execSafe(...args: [any, any]) {
        try {
          return (await this.exec(...args)) as any
        } catch (err: any) {
          return err
        }
      },
      fail(msg: string | { message: string }): never {
        throw msg
      },
      log(
        level: "fatal" | "error" | "warn" | "info" | "debug" | "trace",
        message: any
      ): void {
        logger[level](message)
      },
      logger: logger,
      progress(data) {
        logger.info({ msg: "Progress", data })
      },
      provider,
      variables: merge(context, this.variables || {}),
      warn(opts: { message: string } | string): void {
        const message = typeof opts === "string" ? opts : opts.message
        logger.warn({ msg: message })
      }
    }
  }
}
