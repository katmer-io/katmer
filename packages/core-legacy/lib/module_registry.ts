import type { KatmerCore } from "./katmer"

import * as modules from "./modules/index"

import type { KatmerProvider } from "./interfaces/provider.interface"

import { isClass } from "./utils/object.utils"
import type { KatmerModule } from "./module"

export class KatmerModuleRegistry {
  #moduleMap = new Map<string, (...args: any[]) => KatmerModule>()
  constructor(private core: KatmerCore) {
    this.registerDefaultModules()
  }

  register(module: any) {
    let moduleWrapper
    let name = module?.name
    if (!name) {
      throw new Error(`modules must have a 'name' property`)
    }

    if (isClass(module)) {
      moduleWrapper = (params: any, provider: KatmerProvider) =>
        new module(params, provider)
    } else if (typeof module === "function") {
      name = name.replace(/Module$/, "").toLowerCase()
      moduleWrapper = (params: any, provider: KatmerProvider) =>
        module(params, provider)
    } else if (typeof module === "object") {
      moduleWrapper = (params: any) => module
    } else {
      throw new Error(`Module ${name} is not a valid module`)
    }
    this.#moduleMap.set(name, moduleWrapper)
  }

  has(name: string): boolean {
    return this.#moduleMap.has(name)
  }

  get(name: string, params: any = {}) {
    const module = this.#moduleMap.get(name)
    if (!module) {
      throw new Error(`Module ${name} not found`)
    }
    const moduleInstance = module(params)
    Object.defineProperty(moduleInstance, "logger", {
      get: () => {
        return this.core.logger.child({ module: name })
      }
    })

    return moduleInstance
  }

  registerDefaultModules() {
    for (const [name, module] of Object.entries(modules)) {
      if (name.endsWith("Module")) {
        this.register(module)
      }
    }
  }
}
