import { type ModuleCommonReturn } from "../../interfaces/module.interface"
import { SSHProvider } from "../../providers/ssh/ssh.provider"
import type { KatmerProvider } from "../../interfaces/provider.interface"

import { HttpModule as HTTPCurlModule } from "./http.curl.module"
import { HttpModule as HTTPLocalModule } from "./http.local.module"

declare module "../../interfaces/task.interface" {
  export namespace Katmer {
    export interface TaskActions {
      /**
       * Perform an HTTP(S) request.
       * See HttpModuleOptions for all parameters.
       */
      http?: HttpModuleOptions
    }
  }
}

/**
 * HTTP methods
 * @public
 */
type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "TRACE"
  | "CONNECT"

type HttpBasicAuth = {
  /**
   * Use Basic authentication.
   * @defaultValue "basic"
   */
  type: "basic"
  /**
   * Username used for basic auth.
   */
  username: string
  /**
   * Password used for basic auth.
   */
  password: string
}
type HttpBearerAuth = {
  /**
   * Use Bearer token authentication.
   * @defaultValue "bearer"
   */
  type: "bearer"
  /**
   * Bearer token to send in Authorization header.
   */
  token: string
}
/**
 * Authentication configuration.
 * @public
 */
export type HttpAuth = HttpBasicAuth | HttpBearerAuth

/**
 * Retry configuration.
 * @public
 */
export interface HttpRetry {
  /**
   * Total number of retry attempts on transient failures.
   * Maps to: --retry [tries]
   */
  tries?: number
  /**
   * Delay in seconds between retries.
   * Maps to: --retry-delay [seconds]
   */
  delay?: number
  /**
   * Total time limit in seconds for all retries.
   * Maps to: --retry-max-time [seconds]
   */
  max_time?: number
}

/**
 * Output configuration for the response body.
 * @public
 */
export interface HttpOutput {
  /**
   * Remote path to save the response body to.
   * If set, the module writes to a temporary file and atomically moves it into place.
   */
  toFile?: string
  /**
   * Additionally capture the response body in the module result (body field).
   * Note: may increase memory usage for large responses.
   */
  captureBody?: boolean
}

/**
 * Options for the http module.
 * @public
 */
export interface HttpModuleOptions {
  /**
   * Target URL
   */
  url: string | URL
  /**
   * HTTP method to use.
   * @defaultValue "GET"
   *
   * Special handling:
   * - When method is "HEAD" and writing to file, uses `-X HEAD`.
   * - When method is "HEAD" and not writing to file, uses `-I`.
   */
  method?: HttpMethod
  /**
   * Additional HTTP headers to send.
   * @example
   * ```ts
   * headers: { "Accept": "application/json", "User-Agent": "katmer" }
   * ```
   */
  headers?: Record<string, string>
  /**
   * Key-value query parameters to append to the URL.
   * Null or undefined values are skipped.
   */
  query?: Record<string, string | number | boolean | null | undefined>
  /**
   * Request body.
   * - If an object is provided, it is JSON-encoded and `Content-Type: application/json` is added unless already set.
   * - If a string is provided, it is sent via `--data-binary "string"`.
   * - For binary payloads, prefer {@link HttpModuleOptions.bodyFile | bodyFile}.
   */
  body?: string | Record<string, any> | Uint8Array
  /**
   * Remote path to a file whose content will be sent via `--data-binary @[file]`.
   */
  bodyFile?: string
  /**
   * Authentication configuration (basic or bearer).
   */
  auth?: HttpAuth
  /**
   * Total request timeout in seconds.
   * Maps to: `--max-time [seconds]`
   * @defaultValue 30
   */
  timeout?: number
  /**
   * Follow redirects.
   * Maps to: `-L`
   * @defaultValue true
   */
  follow_redirects?: boolean
  /**
   * Validate TLS certificates. If false, passes `--insecure`.
   * @defaultValue true
   */
  validate_certs?: boolean
  /**
   * Output configuration. A string is shorthand for `output.toFile`.
   */
  output?: HttpOutput | string
  /**
   * Remote path to save response headers.
   * Maps to: `-D [file]`
   */
  save_headers_to?: string
  /**
   * Treat non-2xx HTTP codes as fatal.
   * Maps to: `--fail-with-body`
   * @defaultValue true
   */
  fail_on_http_error?: boolean
  /**
   * Retry settings.
   */
  retry?: HttpRetry
  /**
   * Additional raw arguments to append to the curl command. Only works with Local provider
   */
  extra_args?: string[]
  /**
   * File mode to set on output file (when `output.toFile` is set).
   * Accepts octal number (e.g., `0o644`) or string (e.g., `"0644"`).
   */
  mode?: string | number
  /**
   * File owner to set on the output file (`chown`).
   */
  owner?: string
  /**
   * File group to set on the output file (`chown`).
   */
  group?: string
}

/**
 * Result returned by the http module.
 * @public
 */
export interface HttpModuleResult extends ModuleCommonReturn {
  /**
   * Parsed whatwg-url URL object.
   */
  url: URL
  /**
   * Parsed HTTP status code when available (best-effort).
   */
  status?: number
  /**
   * Raw response headers if saved via {@link HttpModuleOptions.save_headers_to | save_headers_to}.
   */
  headers?: Record<string, string | string[]>
  /**
   * Response body if `captureBody=true`, or when output is not used and `captureBody=true`.
   */
  body?: string
  /**
   * Destination path when `output.toFile` (or string shorthand) was used.
   */
  dest?: string
}

/**
 * Execute HTTP(S) requests.
 *
 *
 * @remarks
 * - Uses `curl` when running with ssh provider
 * - Follows redirects by default (`-L`).
 * - Validates TLS by default; set {@link HttpModuleOptions.validate_certs | validate_certs}: false to pass `--insecure`.
 * - When {@link HttpModuleOptions.output | output.toFile} is set, writes to a temporary file then moves atomically; `changed=true` on success.
 * - If {@link HttpModuleOptions.fail_on_http_error | fail_on_http_error} is true (default), non-2xx responses cause a failure using `--fail-with-body`.
 * - Best-effort status parsing is performed from saved headers or stderr when available.
 *
 * @examples
 * ```yaml
 * - name: Download a file to a path (like get_url)
 *   http:
 *     url: "https://example.com/app.tar.gz"
 *     output: "/opt/app/app.tar.gz"
 *     mode: "0644"
 *
 * - name: GET JSON with headers and save response headers
 *   http:
 *     url: "https://api.example.com/meta"
 *     headers:
 *       Accept: "application/json"
 *     save_headers_to: "/tmp/meta.headers"
 *     output:
 *       toFile: "/tmp/meta.json"
 *       captureBody: true
 *
 * - name: POST JSON with bearer token
 *   http:
 *     url: "https://api.example.com/resources"
 *     method: "POST"
 *     headers:
 *       Accept: "application/json"
 *     body:
 *       name: "demo"
 *       enabled: true
 *     auth:
 *       type: "bearer"
 *       token: "{{ MY_API_TOKEN }}"
 *     fail_on_http_error: true
 *
 * - name: Download with basic auth
 *   http:
 *     url: "https://intranet.local/file.bin"
 *     auth:
 *       type: "basic"
 *       username: "user"
 *       password: "pass"
 *     validate_certs: false
 *     retry:
 *       tries: 5
 *       delay: 2
 * ```
 * @public
 */
export function HttpModule(opts: HttpModuleOptions, provider: KatmerProvider) {
  if (provider instanceof SSHProvider) {
    return new HTTPCurlModule(opts, provider)
  } else {
    return new HTTPLocalModule(opts, provider)
  }
}
