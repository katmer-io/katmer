import { SSHProvider } from "./ssh.provider"
import { baseName, targetDir } from "../../utils/path.utils"
import { toOctal } from "../../utils/number.utils"

/**
 * Split string into lines while keeping separators.
 */
function splitLinesIncludeSeparators(str: string): string[] {
  const linesWithSeparators: string[] = []
  const parts = str.split(/(\r\n|\r+|\n)/)
  for (let i = 0; i < Math.ceil(parts.length / 2); i++) {
    linesWithSeparators.push(parts[2 * i] + (parts[2 * i + 1] ?? ""))
  }
  return linesWithSeparators
}

/**
 * Returns a handler that buffers chunks and emits complete lines.
 */
export function makeLineEmitter(cb: (line: string, buffer: string) => void) {
  let buffer = ""
  return (chunk: string) => {
    buffer += chunk
    const lines = splitLinesIncludeSeparators(buffer)
    const last = lines[lines.length - 1]
    const hasSep = last.endsWith("\n") || last.endsWith("\r")
    const emit = hasSep ? lines : lines.slice(0, -1)
    buffer = hasSep ? "" : last
    for (const line of emit) cb(line, buffer)
  }
}
