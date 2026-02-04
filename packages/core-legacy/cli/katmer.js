#!/usr/bin/env bun

import { Command } from "commander"
import { version, description } from "../package.json"
import run from "./run"

const cli = new Command()
cli
  .name("katmer")
  .description(description)
  .option(
    "-t, --target [files...]",
    "Path to config file",
    "/etc/katmer/config.yaml"
  )
  .option("--cwd [dir]", "Override working directory")
  .version(version, "-v, --version")
  .helpOption("--help")

run(cli)

try {
  await cli.parseAsync(process.argv)
} catch (e) {
  console.error(e)
  console.error(e.message || e)
  process.exit(1)
}
