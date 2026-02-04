import { uint8ArrayToString } from "uint8array-extras"
import { safeJsonParse } from "./json.utils"

export async function executeScript<T extends boolean = false>(
  scriptContents: string,
  opts: {
    /**
     * Parse stdout/stderr as json. If not valid json the data will be available in `.message`
     */
    json?: T
    /**
     * If provided will be called with each line of script stdout
     */
    stream?: (
      err?: (T extends true ? any : string) | null,
      data?: (T extends true ? any : string) | null
    ) => void
  } = {}
) {
  const command = Bun.spawn(["bash", "-s", "<", "<(cat)"], {
    stdin: new Response(scriptContents),
    stdout: "pipe",
    stderr: "pipe"
  })

  if (opts.stream) {
    command.stdout.pipeTo(
      new WritableStream({
        write(log) {
          if (log.length) {
            const str = uint8ArrayToString(log).trim()
            if (str) {
              opts.stream?.(undefined, opts.json ? safeJsonParse(str) : str)
            }
          }
        }
      })
    )

    command.stderr.pipeTo(
      new WritableStream({
        write(log) {
          const str = uint8ArrayToString(log).trim()
          if (str) {
            opts.stream?.(opts.json ? safeJsonParse(str) : str)
          }
        }
      })
    )
  }

  const failed = (await command.exited) !== 0

  if (!opts.stream) {
    let stdout = await new Response(command.stdout).text()
    let stderr = await new Response(command.stderr).text()
    if (opts.json) {
      stdout = safeJsonParse(stdout)
      stderr = safeJsonParse(stderr)
    }

    if (failed) {
      throw stderr
    }
    return stdout
  }
}

export async function executeShellCommand(cmd: string) {
  try {
    const command = Bun.spawn(cmd.split(" "), {
      stdout: "pipe",
      stderr: "pipe"
    })

    const output = {
      code: null as null | number,
      stdout: [] as string[],
      stderr: [] as string[]
    }
    command.stdout.pipeTo(
      new WritableStream({
        write(log) {
          if (log.length) {
            const str = uint8ArrayToString(log).trim()
            if (str) {
              output.stdout.push(str)
            }
          }
        }
      })
    )

    command.stderr.pipeTo(
      new WritableStream({
        write(log) {
          const str = uint8ArrayToString(log)
          output.stderr.push(str)
        }
      })
    )

    output.code = await command.exited
    return output
  } catch (e) {
    const err = e as InstanceType<typeof Bun.$.ShellError>
    if ("exitCode" in err) {
      return {
        code: err.exitCode,
        stdout: [err.stdout.toString("utf-8")],
        stderr: [err.stderr.toString("utf-8")]
      }
    }
    throw e
  }
}
