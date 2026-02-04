import path from "node:path"
import fs from "node:fs/promises"

const EXECUTABLE_NAME = "katmer"

function localPath(...paths: string[]) {
  return path.resolve(import.meta.dirname, "..", ...paths)
}

await fs.rm(localPath("bin"), { force: true, recursive: true })
await fs.rm(localPath("dist"), { force: true, recursive: true })

function releaseFileName(target: string) {
  if (target.includes("windows")) {
    return `${EXECUTABLE_NAME}-${target}.exe`
  }
  return `${EXECUTABLE_NAME}-${target}`
}

try {
  for (const target of [
    "linux-x64",
    "linux-arm64",
    "windows-x64",
    "darwin-arm64",
    "darwin-x64"
  ] as const) {
    console.log(`Building for ${target}`)
    await Bun.build({
      entrypoints: [localPath("cli/katmer.js")],
      root: localPath(),
      target: "bun",
      compile: {
        target: `bun-${target}`,
        autoloadDotenv: false,
        autoloadBunfig: false,
        outfile: localPath(`./dist/releases/${releaseFileName(target)}`)
      }
    })
  }
} catch (err: any) {
  console.error(err)
  process.exit(1)
}

export {}
