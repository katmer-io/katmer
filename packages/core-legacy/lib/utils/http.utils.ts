export function parseHeaderString(headerStr: string = "") {
  const lines = headerStr.trim().split(/\r?\n/)
  const pairs = lines
    .filter((l) => l.includes(":"))
    .map((l) => {
      const [key, ...rest] = l.split(":")
      return [key.trim(), rest.join(":").trim()]
    })
  return Object.fromEntries(new Headers(pairs))
}
