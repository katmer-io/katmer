import fs from "node:fs"
import path from "node:path"

const pkgPath = path.resolve(process.cwd(), "package.json")
const cargoPath = path.resolve(process.cwd(), "Cargo.toml")
const lockPath = path.resolve(process.cwd(), "Cargo.lock")

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
const version = pkg.version

if (typeof version !== "string" || version.trim() === "") {
  throw new Error("package.json version is missing")
}

const cargo = fs.readFileSync(cargoPath, "utf8")
const lines = cargo.split(/\r?\n/)

let inPackage = false
let changed = false
const out = lines.map((line) => {
  if (/^\[package\]\s*$/.test(line)) {
    inPackage = true
    return line
  }
  if (inPackage && line.startsWith("[")) {
    inPackage = false
  }
  if (inPackage && /^version\s*=\s*"[^"]+"\s*$/.test(line)) {
    changed = true
    return `version = "${version}"`
  }
  return line
})

if (!changed) {
  throw new Error("failed to update Cargo.toml version")
}

fs.writeFileSync(cargoPath, out.join("\n"), "utf8")

if (fs.existsSync(lockPath)) {
  const lock = fs.readFileSync(lockPath, "utf8")
  const lockLines = lock.split(/\r?\n/)

  let inPkg = false
  let isCore = false
  let lockChanged = false

  const lockOut = lockLines.map((line) => {
    if (/^\[\[package\]\]\s*$/.test(line)) {
      inPkg = true
      isCore = false
      return line
    }
    if (inPkg && /^name\s*=\s*"katmer-core"\s*$/.test(line)) {
      isCore = true
      return line
    }
    if (inPkg && isCore && /^version\s*=\s*"[^"]+"\s*$/.test(line)) {
      lockChanged = true
      inPkg = false
      isCore = false
      return `version = "${version}"`
    }
    return line
  })

  if (!lockChanged) {
    throw new Error("failed to update Cargo.lock package version")
  }
  fs.writeFileSync(lockPath, lockOut.join("\n"), "utf8")
}
