import { type ModuleConstraints } from "../../interfaces/module.interface"
import { type Katmer } from "../../interfaces/task.interface"
import type {
  HttpModuleOptions,
  HttpModuleResult,
  HttpOutput
} from "./http.module"
import { toOctal } from "../../utils/number.utils"
import { mkdir, writeFile, readFile, chmod, chown } from "fs/promises"
import { basename, dirname } from "path"
import type { BodyInit } from "bun"
import type { KatmerProvider } from "../../interfaces/provider.interface"
import { KatmerModule } from "../../module"

export class HttpModule extends KatmerModule<
  HttpModuleOptions,
  HttpModuleResult
> {
  static name = "http" as const

  constraints = {
    platform: { any: true }
  } satisfies ModuleConstraints

  async check(): Promise<void> {
    const { url } = this.params || ({} as HttpModuleOptions)
    if (!url || typeof url !== "string" || !url.trim()) {
      throw new Error("'url' is required")
    }
    if (!URL.canParse(url)) {
      throw new Error("'url' is not a valid URL")
    }
  }

  async execute(_ctx: Katmer.TaskContext): Promise<HttpModuleResult> {
    const {
      url,
      method = "GET",
      headers = {},
      query,
      body,
      bodyFile,
      auth,
      timeout = 30,
      follow_redirects = true,
      validate_certs = true,
      output,
      save_headers_to,
      fail_on_http_error = true,
      retry,
      mode,
      owner,
      group
    } = this.params

    const parsedUrl = new URL(url)
    for (const [key, val] of Object.entries(query || {})) {
      parsedUrl.searchParams.set(key, String(val))
    }
    const finalUrl = parsedUrl.toString()
    const reqHeaders = new Headers(headers)

    // Auth
    if (auth?.type === "basic") {
      const token = Buffer.from(`${auth.username}:${auth.password}`).toString(
        "base64"
      )
      reqHeaders.set("Authorization", `Basic ${token}`)
    } else if (auth?.type === "bearer") {
      reqHeaders.set("Authorization", `Bearer ${auth.token}`)
    }

    // Prepare body
    let reqBody: BodyInit | undefined
    if (bodyFile) {
      reqBody = await readFile(bodyFile)
    } else if (typeof body !== "undefined") {
      if (
        typeof body === "object" &&
        !(body instanceof Uint8Array) &&
        !reqHeaders.has("Content-Type")
      ) {
        reqHeaders.set("Content-Type", "application/json")
        reqBody = JSON.stringify(body)
      } else if (typeof body === "string" || body instanceof Uint8Array) {
        reqBody = body
      }
    }

    // Setup timeout and retry
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout * 1000)

    let res: Response | undefined
    let lastError: any
    const tries = retry?.tries ?? 1
    const delay = retry?.delay ?? 0

    for (let i = 0; i < tries; i++) {
      try {
        res = await fetch(finalUrl, {
          method,
          headers: reqHeaders,
          body: reqBody,
          redirect: follow_redirects ? "follow" : "manual",
          signal: controller.signal
        })
        break
      } catch (err) {
        lastError = err
        if (i < tries - 1) {
          await new Promise((r) => setTimeout(r, delay * 1000))
        }
      }
    }

    clearTimeout(timer)

    if (!res) {
      throw {
        url: parsedUrl,
        changed: false,
        msg: `HTTP request failed: ${String(lastError)}`,
        status: undefined,
        headers: undefined,
        body: undefined,
        dest: undefined
      } satisfies HttpModuleResult
    }

    const status = res.status
    const headersText = Array.from(res.headers.entries())
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")

    const parsedHeaders = res.headers.toJSON()

    // Save headers if requested
    if (save_headers_to) {
      await mkdir(dirname(save_headers_to), { recursive: true })
      const hdrTxt = `HTTP/${res.ok ? "1.1" : ""} ${status}\n${headersText}\n`
      await writeFile(save_headers_to, hdrTxt, "utf8")
    }

    // Handle output
    const normalizedOutput: HttpOutput =
      typeof output === "string" ? { toFile: output } : output || {}
    const toFile = normalizedOutput.toFile
    const captureBody =
      normalizedOutput.captureBody !== undefined ?
        !!normalizedOutput.captureBody
      : false

    let bodyText: string | undefined
    let dest: string | undefined

    if (toFile) {
      // If we also want to capture the body, clone the response
      if (captureBody) {
        const resCopy = res.clone()
        const [ab, text] = await Promise.all([
          res.arrayBuffer(), // for writing the file
          resCopy.text() // for returning body as text
        ])
        const buf = new Uint8Array(ab)

        await mkdir(dirname(toFile), { recursive: true })
        await writeFile(toFile, buf)

        if (mode != null) await chmod(toFile, toOctal(mode) ?? 0o644)
        if (owner != null || group != null) {
          await chown(
            toFile,
            Number(owner ?? process.getuid?.() ?? 0),
            Number(group ?? process.getgid?.() ?? 0)
          ).catch(() => {})
        }

        dest = toFile
        bodyText = text

        return {
          url: parsedUrl,
          changed: true,
          status,
          headers: Object.fromEntries(res.headers.entries()),
          body: bodyText,
          dest
        } satisfies HttpModuleResult
      } else {
        // No capture → just consume once
        const ab = await res.arrayBuffer()
        const buf = new Uint8Array(ab)

        await mkdir(dirname(toFile), { recursive: true })
        await writeFile(toFile, buf)

        if (mode != null) await chmod(toFile, toOctal(mode) ?? 0o644)
        if (owner != null || group != null) {
          await chown(
            toFile,
            Number(owner ?? process.getuid?.() ?? 0),
            Number(group ?? process.getgid?.() ?? 0)
          ).catch(() => {})
        }

        dest = toFile
        return {
          url: parsedUrl,
          changed: true,
          status,
          headers: Object.fromEntries(res.headers.entries()),
          body: undefined,
          dest
        } satisfies HttpModuleResult
      }
    }

    // No file output → safe to read once as text
    if (captureBody) {
      bodyText = await res.text()
    }

    if (!res.ok && fail_on_http_error) {
      throw {
        url: parsedUrl,
        changed: false,
        status,
        headers: Object.fromEntries(res.headers.entries()),
        body: bodyText,
        dest,
        msg: `HTTP ${status}: ${res.statusText}`
      } satisfies HttpModuleResult
    }

    return {
      url: parsedUrl,
      changed: false,
      status,
      headers: Object.fromEntries(res.headers.entries()),
      body: bodyText,
      dest
    } satisfies HttpModuleResult
  }

  cleanup(ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {
    return Promise.resolve(undefined)
  }

  initialize(ctx: Katmer.TaskContext<KatmerProvider>): Promise<void> {
    return Promise.resolve(undefined)
  }
}
