import { get } from "es-toolkit/compat"
import { parseLines } from "../../utils/string.utils"
import path from "node:path"
import type { Katmer } from "../../interfaces/task.interface"
import type { SSHProvider } from "../../providers/ssh/ssh.provider"
import { UnixComms } from "../../utils/unix.utils"

type SourceEntry = {
  valid: boolean
  enabled: boolean
  source: string
  comment: string
}

const VALID_SOURCE_TYPES = new Set(["deb", "deb-src"])

export class InvalidSource extends Error {
  constructor(line: string) {
    super(`Invalid or disabled APT source: ${line}`)
    this.name = "InvalidSource"
  }
}

export class SourcesList {
  files: Record<string, (SourceEntry & { n: number })[]> = {}
  files_map: Record<string, string> = {}
  new_repos = new Set<string>()
  default_file!: string
  sources_dir!: string

  constructor(
    private aptConfig: Record<string, any>,
    private ctx: Katmer.TaskContext<SSHProvider>
  ) {}

  async init() {
    const rootDir = this.aptConfig["Dir"]
    const aptDir = this.aptConfig["Dir::Etc"]
    const sourcesDir = this.aptConfig["Dir::Etc::sourceparts"]
    const sourcesList = this.aptConfig["Dir::Etc::sourcelist"]

    this.default_file = path.posix.join(rootDir, aptDir, sourcesList)
    if (await UnixComms.pathIsFile(this.ctx, this.default_file)) {
      await this.load(this.default_file)
    }

    this.sources_dir = path.posix.join(rootDir, aptDir, sourcesDir)
    const { stdout } = await this.ctx.exec(
      `bash -lc 'shopt -s nullglob; for f in "${this.sources_dir}"/*.list; do echo "$f"; done'`
    )
    const files = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)

    for (const file of files) {
      if (await UnixComms.pathIsSymlink(this.ctx, file)) {
        const link = await UnixComms.readlink(this.ctx, file)
        if (link) this.files_map[file] = link
      }
      await this.load(file)
    }
  }

  async load(sourcesFile: string): Promise<void> {
    const group: (SourceEntry & { n: number })[] = []
    const fileContents = await UnixComms.readFileUtf8(this.ctx, sourcesFile)
    if (fileContents) {
      const lines = parseLines(fileContents)
      for (let i = 0; i < lines.length; i++) {
        const res = this._parse_source_line(lines[i])
        group.push({ n: i, ...res })
      }
      this.files[sourcesFile] = group
    } else {
      this.files[sourcesFile] = []
    }
  }

  async save(): Promise<void> {
    // Build desired contents
    const desired: Record<string, string> = {}
    for (const [filename, sources] of Object.entries(this.files)) {
      if (!sources || sources.length === 0) continue
      const lines: string[] = []
      for (const { enabled, source, comment } of sources) {
        const chunks: string[] = []
        if (!enabled) chunks.push("# ")
        chunks.push(source)
        if (comment) {
          chunks.push(" # ")
          chunks.push(comment)
        }
        chunks.push("\n")
        lines.push(chunks.join(""))
      }
      desired[filename] = lines.join("")
    }

    // Read current contents for comparison
    const current: Record<string, string> = {}
    const filenames = new Set<string>([
      ...Object.keys(this.files),
      ...Object.keys(this.files_map)
    ])
    for (const filename of filenames) {
      const target = this.files_map[filename] ?? filename
      current[filename] = (await UnixComms.readFileUtf8(this.ctx, target)) ?? ""
    }

    // Write only changed files
    for (const [filename, sources] of Object.entries(this.files)) {
      const target = this.files_map[filename] ?? filename
      const want = desired[filename] ?? ""
      const have = current[filename] ?? ""

      if (sources && sources.length > 0) {
        if (want === have) continue

        const dir = filename.substring(0, filename.lastIndexOf("/")) || "/"
        await UnixComms.mkdirp(this.ctx, dir)

        const modeRaw = get(this.aptConfig, "mode") as
          | number
          | string
          | undefined
        const numeric =
          modeRaw !== undefined ?
            typeof modeRaw === "number" ?
              modeRaw
            : parseInt(String(modeRaw), 8)
          : undefined

        await UnixComms.writeFileAtomic(
          this.ctx,
          target,
          want,
          Number.isNaN(numeric as any) ? undefined : numeric
        )
      }
    }

    // Remove only files that became empty (and only if they existed or are mapped)
    for (const [filename, sources] of Object.entries(this.files)) {
      if (sources && sources.length > 0) continue
      delete this.files[filename]
      await UnixComms.removePath(this.ctx, filename)
    }
  }

  modify(
    file: string,
    n: number,
    enabled?: boolean,
    source?: string,
    comment?: string
  ): void {
    const current = this.files[file]?.[n]
    if (!current) return
    const valid = current.valid
    const enabledOld = current.enabled
    const sourceOld = current.source
    const commentOld = current.comment
    this.files[file][n] = {
      n,
      valid,
      enabled: this._choice(enabled, enabledOld),
      source: this._choice(source, sourceOld),
      comment: this._choice(comment, commentOld)
    }
  }

  add_source(line: string, comment = "", file?: string | null) {
    const { source } = this._parse_source_line(line, true)
    const suggested = this._suggest_filename(source)
    this._add_valid_source(source, comment, file || suggested)
  }

  remove_source(line?: string, regexp?: string) {
    if (regexp) {
      this._remove_valid_source(undefined, regexp)
    } else if (line) {
      const { source } = this._parse_source_line(line, true)
      this._remove_valid_source(source)
    }
  }

  dump(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [filename, sources] of Object.entries(this.files)) {
      if (!sources || sources.length === 0) continue
      const lines: string[] = []
      for (const { enabled, source, comment } of sources) {
        const chunks: string[] = []
        if (!enabled) chunks.push("# ")
        chunks.push(source)
        if (comment) {
          chunks.push(" # ")
          chunks.push(comment)
        }
        chunks.push("\n")
        lines.push(chunks.join(""))
      }
      out[filename] = lines.join("")
    }
    return out
  }

  protected _parse_source_line(
    lineIn: string,
    raiseIfInvalidOrDisabled = false
  ): SourceEntry {
    let valid = false
    let enabled = true
    let source = ""
    let comment = ""

    let line = lineIn.trim()
    if (line.startsWith("#")) {
      enabled = false
      line = line.slice(1)
    }

    const hashIdx = line.indexOf("#")
    if (hashIdx > 0) {
      comment = line.slice(hashIdx + 1).trim()
      line = line.slice(0, hashIdx)
    }

    source = line.trim()
    if (source) {
      const chunks = source.split(/\s+/).filter(Boolean)
      if (chunks.length > 0 && VALID_SOURCE_TYPES.has(chunks[0])) {
        valid = true
        source = chunks.join(" ")
      }
    }

    if (raiseIfInvalidOrDisabled && (!valid || !enabled)) {
      throw new InvalidSource(lineIn)
    }

    return { valid, enabled, source, comment }
  }

  protected _expand_path(filename: string): string {
    filename = filename.endsWith(".list") ? filename : `${filename}.list`
    if (filename.includes("/")) return filename
    return `${this.sources_dir.replace(/\/+$/, "")}/${filename}`
  }

  protected _suggest_filename(
    line: string,
    params?: { filename?: string }
  ): string {
    const cleanupFilename = (s: string) => {
      const explicit = params?.filename
      if (explicit != null) return explicit
      return s
        .replace(/[^a-zA-Z0-9]/g, " ")
        .trim()
        .split(/\s+/)
        .join("_")
    }
    const stripUserPass = (s: string) => {
      if (s.includes("@")) {
        const parts = s.split("@")
        return parts[parts.length - 1]
      }
      return s
    }

    let work = line.replace(/\[[^\]]+\]/g, "")
    work = work.replace(/\w+:\/\//g, "")

    const parts = work
      .split(/\s+/)
      .filter((p) => p && !VALID_SOURCE_TYPES.has(p))

    if (parts.length > 0) {
      parts[0] = stripUserPass(parts[0])
    }

    const base = cleanupFilename(parts.slice(0, 1).join(" "))
    return `${base}.list`
  }

  protected _choice<T>(n: T | undefined | null, old: T): T {
    return n == null ? old : n
  }

  protected _add_valid_source(
    source_new: string,
    comment_new: string,
    file?: string | null
  ) {
    let found = false
    for (const [filename, n, _enabled, src] of this) {
      if (src === source_new) {
        this.modify(filename, n, true)
        found = true
      }
    }

    if (!found) {
      let targetFile: string
      if (!file) {
        targetFile = this.default_file
      } else {
        targetFile = this._expand_path(file)
      }

      if (!this.files[targetFile]) {
        this.files[targetFile] = []
      }
      const list = this.files[targetFile]
      list.push({
        n: list.length,
        valid: true,
        enabled: true,
        source: source_new,
        comment: comment_new
      })
      this.new_repos.add(targetFile)
    }
  }

  protected _remove_valid_source(source: string | undefined, regexp?: string) {
    for (const [filename, n, enabled, src] of this) {
      if (enabled) {
        if (src === source || (regexp && new RegExp(regexp).test(src))) {
          this.files[filename].splice(n, 1)
          this.files[filename] = this.files[filename].map((e, idx) => ({
            ...e,
            n: idx
          }))
        }
      }
    }
  }

  *[Symbol.iterator](): IterableIterator<
    [file: string, n: number, enabled: boolean, source: string, comment: string]
  > {
    for (const [file, sources] of Object.entries(this.files)) {
      for (const entry of sources) {
        if (entry.valid) {
          yield [file, entry.n, entry.enabled, entry.source, entry.comment]
        }
      }
    }
  }

  toJSON() {
    return {
      files: this.files,
      files_map: this.files_map,
      default_file: this.default_file,
      sources_dir: this.sources_dir,
      new_repos: Array.from(this.new_repos)
    }
  }
}
