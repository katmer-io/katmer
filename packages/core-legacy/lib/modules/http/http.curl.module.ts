import { type ModuleConstraints } from "../../interfaces/module.interface"
import type { SSHProvider } from "../../providers/ssh/ssh.provider"
import type { Katmer } from "../../interfaces/task.interface"
import { toOctal } from "../../utils/number.utils"
import type {
  HttpModuleOptions,
  HttpOutput,
  HttpModuleResult
} from "./http.module"
import { quote } from "../../utils/string.utils"
import type { KatmerProvider } from "../../interfaces/provider.interface"
import { parseHeaderString } from "../../utils/http.utils"
import { KatmerModule } from "../../module"

export class HttpModule extends KatmerModule<
  HttpModuleOptions,
  HttpModuleResult,
  SSHProvider
> {
  static name = "http" as const

  constraints = {
    platform: {
      linux: { packages: ["curl"] },
      darwin: { packages: ["curl"] }
    }
  } satisfies ModuleConstraints

  /**
   * Validate environment and parameters before execution.
   *
   * @throws Error if `url` is missing.
   */
  async check(ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {
    const { url } = this.params || ({} as HttpModuleOptions)
    if (!url || typeof url !== "string" || !url.trim()) {
      throw new Error("'url' is required")
    }

    if (!URL.canParse(url)) {
      throw new Error("'url' is not a valid URL")
    }
  }

  async initialize(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}
  async cleanup(_ctx: Katmer.TaskContext<SSHProvider>): Promise<void> {}

  /**
   * Execute the http command with given options.
   *
   * @param ctx - Task context with remote executor.
   * @returns The {@link HttpModuleResult}.
   *
   * @throws {@link HttpModuleResult} (thrown as an error object) when
   * {@link HttpModuleOptions.fail_on_http_error | fail_on_http_error} is true and http exits non-zero.
   */
  async execute(
    ctx: Katmer.TaskContext<SSHProvider>
  ): Promise<HttpModuleResult> {
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
      extra_args = [],
      mode,
      owner,
      group
    } = this.params

    const parsedUrl = new URL(url)
    for (const [key, val] of Object.entries(query || {})) {
      parsedUrl.searchParams.set(key, String(val))
    }
    const finalUrl = parsedUrl.toString()
    const urlArg = quote(finalUrl)

    // Header args
    const headerArgs: string[] = []
    for (const [k, v] of Object.entries(headers)) {
      headerArgs.push(`-H ${quote(`${k}: ${v}`)}`)
    }

    // Auth
    if (auth?.type === "basic") {
      headerArgs.push(`-u ${quote(`${auth.username}:${auth.password}`)}`)
    } else if (auth?.type === "bearer") {
      headerArgs.push(`-H ${quote(`Authorization: Bearer ${auth.token}`)}`)
    }

    // Body
    let dataArg: string | undefined
    if (bodyFile) {
      dataArg = `--data-binary @${quote(bodyFile)}`
    } else if (typeof body !== "undefined") {
      const { dataArg: d, headerArgs: extraHdrs } = ensureJsonBody(
        body,
        headers
      )
      dataArg = d
      headerArgs.push(...extraHdrs)
    }

    // Flags
    const flags = [
      "-sS",
      follow_redirects ? "-L" : "",
      validate_certs ? "" : "--insecure",
      timeout ? `--max-time ${timeout}` : "",
      fail_on_http_error ? "--fail-with-body" : "",
      retry?.tries ? `--retry ${retry.tries}` : "",
      retry?.delay ? `--retry-delay ${retry.delay}` : "",
      retry?.max_time ? `--retry-max-time ${retry.max_time}` : ""
    ]
      .filter(Boolean)
      .join(" ")

    // Save headers
    const headerOutArg = save_headers_to ? `-D ${quote(save_headers_to)}` : ""

    // Output normalization
    const normalizedOutput: HttpOutput =
      typeof output === "string" ? { toFile: output } : output || {}
    const toFile = normalizedOutput.toFile
    const captureBody = !!normalizedOutput.captureBody

    // Temp file for body when writing to file
    const tmpFile = `/tmp/katmer-http-${Date.now()}.body.tmp`
    const outArg = toFile ? `-o ${quote(tmpFile)}` : ""

    // Method argument
    const methodArg =
      method === "GET" && !body && !bodyFile ? ""
      : method === "HEAD" && toFile ? "-X HEAD"
      : method === "HEAD" ? "-I"
      : `-X ${method}`

    // Build command
    const cmd = [
      "curl",
      flags,
      methodArg,
      headerOutArg,
      headerArgs.join(" "),
      dataArg || "",
      ...extra_args
    ]
      .filter(Boolean)
      .join(" ")

    const execCmd = [cmd, urlArg, outArg].filter(Boolean).join(" ")

    // Execute
    const res = await ctx.exec(execCmd)

    // Read response status if headers saved
    let status: number | undefined
    let headersText: string | undefined
    if (save_headers_to) {
      const stat = await ctx.exec(`test -f ${quote(save_headers_to)}; echo $?`)
      if (String(stat.stdout).trim() === "0") {
        const hdr = await ctx.exec(`cat ${quote(save_headers_to)}`)
        headersText = hdr.stdout
        const m = headersText.match(/HTTP\/\d+\.\d+\s+(\d{3})/)
        if (m) status = Number(m[1])
      }
    }
    const parsedHeaders = parseHeaderString(headersText)

    // Failures: throw result object
    if (res.code !== 0 && fail_on_http_error) {
      throw {
        url: parsedUrl,
        changed: false,
        status,
        headers: parsedHeaders,
        body: undefined,
        dest: undefined,
        msg: res.stderr || res.stdout || "http request failed"
      } satisfies HttpModuleResult
    }

    // Handle outputs
    let bodyText: string | undefined
    let dest: string | undefined

    if (toFile) {
      // Ensure destination directory exists
      const parent =
        toFile.substring(0, Math.max(0, toFile.lastIndexOf("/"))) || "/"
      await ctx.exec(`mkdir -p -- ${quote(parent)}`)

      // Ensure tmp exists
      const tmpExists = await ctx.exec(`test -f ${quote(tmpFile)}; echo $?`)
      if (String(tmpExists.stdout).trim() !== "0") {
        throw {
          url: parsedUrl,
          changed: false,
          status,
          headers: parsedHeaders,
          body: undefined,
          dest: undefined,
          msg: "http request produced no body"
        } satisfies HttpModuleResult
      }

      // Move into place (always changed on success)
      const modeStr = toOctal(mode) ?? "0644"
      const installCmd = `install -m ${modeStr} -D ${quote(tmpFile)} ${quote(
        toFile
      )} || mv -f ${quote(tmpFile)} ${quote(toFile)}`
      const mv = await ctx.exec(installCmd)
      if (mv.code !== 0) {
        await ctx.exec(`rm -f -- ${quote(tmpFile)}`).catch(() => {})
        throw {
          url: parsedUrl,
          changed: false,
          status,
          headers: parsedHeaders,
          body: undefined,
          dest: undefined,
          msg: mv.stderr || mv.stdout || "failed to move downloaded body"
        } satisfies HttpModuleResult
      }

      // perms
      if (mode != null) {
        const m = toOctal(mode)
        await ctx.exec(`chmod ${m} -- ${quote(toFile)}`).catch(() => {})
      }
      if (owner || group) {
        const chownArg =
          owner && group ? `${owner}:${group}`
          : owner ? owner
          : `:${group}`
        await ctx.exec(`chown ${chownArg} -- ${quote(toFile)}`).catch(() => {})
      }

      dest = toFile
      if (captureBody) {
        const read = await ctx.exec(`cat ${quote(toFile)}`)
        bodyText = read.stdout
      }

      // Return early (changed is always true on successful write)
      return {
        url: parsedUrl,
        changed: true,
        status,
        headers: parsedHeaders,
        body: bodyText,
        dest
      }
    }

    if (captureBody) {
      bodyText = res.stdout
    }

    // Best-effort status parse without -D
    if (typeof status === "undefined" && !save_headers_to) {
      const m = (res.stderr || "").match(/HTTP\/\d+\.\d+\s+(\d{3})/)
      if (m) status = Number(m[1])
    }

    return {
      url: parsedUrl,
      changed: false,
      status,
      headers: parsedHeaders,
      body: bodyText,
      dest
    }
  }
}

/**
 * Build a URL query string from key-value pairs.
 * Skips null/undefined. Booleans and numbers are stringified.
 * @param q Query params map
 * @returns A string beginning with "?" or an empty string
 * @internal
 */
function buildQueryString(q?: HttpModuleOptions["query"]): string {
  if (!q) return ""
  const parts: string[] = []
  for (const [k, v] of Object.entries(q)) {
    if (v === null || typeof v === "undefined") continue
    parts.push(
      `${encodeURIComponent(k)}=${encodeURIComponent(
        typeof v === "string" ? v : String(v)
      )}`
    )
  }
  return parts.length ? `?${parts.join("&")}` : ""
}

/**
 * Normalize and prepare body/headers for JSON requests.
 * - When body is an object, ensures `Content-Type: application/json` and encodes as JSON.
 * - When body is a string/Uint8Array, uses `--data-binary` with the literal content.
 * @param body Body value
 * @param headers Request headers (used to detect pre-set content-type)
 * @returns http data argument and extra header arguments
 * @internal
 */
function ensureJsonBody(
  body: HttpModuleOptions["body"],
  headers: Record<string, string>
): { dataArg?: string; headerArgs: string[] } {
  if (body == null) return { headerArgs: [] }
  const hasCT = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type"
  )
  const headerArgs: string[] = []

  if (typeof body === "string") {
    return { dataArg: `--data-binary ${JSON.stringify(body)}`, headerArgs }
  }

  if (body instanceof Uint8Array) {
    const text = new TextDecoder().decode(body)
    return { dataArg: `--data-binary ${JSON.stringify(text)}`, headerArgs }
  }

  if (!hasCT)
    headerArgs.push(`-H ${JSON.stringify("Content-Type: application/json")}`)
  return {
    dataArg: `--data-binary ${JSON.stringify(JSON.stringify(body))}`,
    headerArgs
  }
}
