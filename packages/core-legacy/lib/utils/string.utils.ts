export function parseLines(content: string, keepEmpty = false): string[] {
  const lines = content.split(/\r?\n/)

  if (keepEmpty) return lines

  return lines.map((l) => l.trim()).filter((l) => l.length > 0)
}

export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim()
}

export function stringifyLines(lines: string[]): string {
  return lines.join("\n") + "\n"
}

/**
 * Shell-safe quoting via JSON stringification.
 * @param v String to quote
 * @internal
 */
export function quote(v: string) {
  return JSON.stringify(v)
}

const escapeRegex = (str: string) =>
  str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1")

export function wildcardMatch(str: string, rule: string) {
  return new RegExp(
    "^" + rule.split("*").map(escapeRegex).join(".*") + "$"
  ).test(str)
}
