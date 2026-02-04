import { Command } from "commander"
import { KatmerCore, type KatmerInitOptions } from "../lib/katmer"

export default function (cli: Command) {
  const command = new Command("run")
    .description("Execute katmer task file")
    .argument("<file>", "The file to run")
    .action(async (file, opts) => {
      const options = cli.opts<KatmerInitOptions>()
      await using instance = new KatmerCore(options)
      await instance.init()
      await instance.run(file)
    })
  cli.addCommand(command)
  return cli
}
