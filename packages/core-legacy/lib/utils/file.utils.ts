import path from "node:path"
import fs, { exists, mkdir } from "node:fs/promises"
import { evalTemplate } from "./renderer/renderer"
import JSON5 from "json5"

export function resolveFile(...args: string[]) {
  return path.resolve(process.cwd(), ...args)
}

export async function ensureDirectory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath)
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true })
  }
}

export async function readKatmerFile(
  filePath: string,
  opts: {
    cwd?: string
    process?: boolean
    processOpts?: any
    errorMessage?: string
  } = {}
): Promise<Record<string, any>> {
  try {
    const isTwigTemplate = filePath.endsWith(".twig")

    const baseFile = path.basename(filePath.replace(/\.twig$/, ""))

    let contents = await fs.readFile(
      path.resolve(opts.cwd || process.cwd(), filePath),
      "utf-8"
    )
    if ((isTwigTemplate && opts.process !== false) || opts.process) {
      contents = await evalTemplate(contents, {}, opts.processOpts)
    }

    return await parseKatmerFile(baseFile, contents)
  } catch (e: any) {
    const message = (typeof e === "string" ? e : e.message) || e
    if (opts.errorMessage) {
      throw new Error(`${opts.errorMessage}: ${message}`)
    }
    throw new Error(message)
  }
}

export async function parseKatmerFile(filename: string, contents?: string) {
  if (!contents) {
    throw new Error(`No contents provided to parse file: ${filename}`)
  }
  try {
    const extension = path.extname(filename)
    if (/\.ya?ml/.test(extension)) {
      return await Bun.YAML.parse(contents)
    } else if (/\.json(c|5|rc)?/.test(extension)) {
      return JSON5.parse(contents)
    } else if (/\.toml/.test(extension)) {
      return Bun.TOML.parse(contents)
    } else {
      throw `Unsupported file type: ${extension}`
    }
  } catch (e: any) {
    const message = (typeof e === "string" ? e : e.message) || e
    throw new Error(message)
  }
}
