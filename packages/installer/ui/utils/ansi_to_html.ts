import { encodeXML } from "./escape_xml"

type ColorMap = { [code: number]: string }

interface FilterOptions {
  fg?: string
  bg?: string
  newline?: boolean
  escapeXML?: boolean
  stream?: boolean
  colors?: ColorMap
}

interface TokenElement {
  token: string
  data: any
  category: string | null
}

const defaults: Required<FilterOptions> = {
  fg: "#FFF",
  bg: "#000",
  newline: false,
  escapeXML: false,
  stream: false,
  colors: getDefaultColors()
}

function getDefaultColors(): ColorMap {
  const colors: ColorMap = {
    0: "#000",
    1: "#A00",
    2: "#0A0",
    3: "#A50",
    4: "#00A",
    5: "#A0A",
    6: "#0AA",
    7: "#AAA",
    8: "#555",
    9: "#F55",
    10: "#5F5",
    11: "#FF5",
    12: "#55F",
    13: "#F5F",
    14: "#5FF",
    15: "#FFF"
  }

  range(0, 5).forEach((red) => {
    range(0, 5).forEach((green) => {
      range(0, 5).forEach((blue) => setStyleColor(red, green, blue, colors))
    })
  })

  range(0, 23).forEach(function (gray) {
    const c = gray + 232
    const l = toHexString(gray * 10 + 8)

    colors[c] = "#" + l + l + l
  })

  return colors
}

function setStyleColor(
  red: number,
  green: number,
  blue: number,
  colors: ColorMap
) {
  const c = 16 + red * 36 + green * 6 + blue
  const r = red > 0 ? red * 40 + 55 : 0
  const g = green > 0 ? green * 40 + 55 : 0
  const b = blue > 0 ? blue * 40 + 55 : 0

  colors[c] = toColorHexString([r, g, b])
}

function toHexString(num: number): string {
  let str = num.toString(16)
  while (str.length < 2) {
    str = "0" + str
  }
  return str
}

function toColorHexString([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map(toHexString).join("")
}

function generateOutput(
  stack: string[],
  token: string,
  data: any,
  options: Required<FilterOptions>
): string | undefined {
  switch (token) {
    case "text":
      return pushText(data, options)
    case "display":
      return handleDisplay(stack, data, options)
    case "xterm256Foreground":
      return pushForegroundColor(stack, options.colors[data])
    case "xterm256Background":
      return pushBackgroundColor(stack, options.colors[data])
    case "rgb":
      return handleRgb(stack, data)
  }
  return undefined
}

function handleRgb(stack: string[], data: string): string {
  data = data.substring(2).slice(0, -1)
  const operation = +data.substr(0, 2)

  const color = data.substring(5).split(";")
  const rgb = color
    .map((value) => ("0" + Number(value).toString(16)).substr(-2))
    .join("")

  return pushStyle(
    stack,
    (operation === 38 ? "color:#" : "background-color:#") + rgb
  )
}

function handleDisplay(
  stack: string[],
  code: number | string,
  options: Required<FilterOptions>
): string | undefined {
  const numCode = parseInt(String(code), 10)

  const codeMap: Record<number, () => string | undefined> = {
    [-1]: () => "<br/>",
    0: () => (stack.length ? resetStyles(stack) : undefined),
    1: () => pushTag(stack, "b"),
    3: () => pushTag(stack, "i"),
    4: () => pushTag(stack, "u"),
    8: () => pushStyle(stack, "display:none"),
    9: () => pushTag(stack, "strike"),
    22: () =>
      pushStyle(
        stack,
        "font-weight:normal;text-decoration:none;font-style:normal"
      ),
    23: () => closeTag(stack, "i"),
    24: () => closeTag(stack, "u"),
    39: () => pushForegroundColor(stack, options.fg),
    49: () => pushBackgroundColor(stack, options.bg),
    53: () => pushStyle(stack, "text-decoration:overline")
  }

  if (codeMap[numCode]) return codeMap[numCode]!()

  if (4 < numCode && numCode < 7) return pushTag(stack, "blink")
  if (29 < numCode && numCode < 38)
    return pushForegroundColor(stack, options.colors[numCode - 30])
  if (39 < numCode && numCode < 48)
    return pushBackgroundColor(stack, options.colors[numCode - 40])
  if (89 < numCode && numCode < 98)
    return pushForegroundColor(stack, options.colors[8 + (numCode - 90)])
  if (99 < numCode && numCode < 108)
    return pushBackgroundColor(stack, options.colors[8 + (numCode - 100)])

  return undefined
}

function resetStyles(stack: string[]): string {
  const stackClone = stack.slice(0)
  stack.length = 0
  return stackClone
    .reverse()
    .map((tag) => `</${tag}>`)
    .join("")
}

function range(low: number, high: number): number[] {
  const results: number[] = []
  for (let j = low; j <= high; j++) results.push(j)
  return results
}

function notCategory(category: string | null) {
  return (e: TokenElement) =>
    (category === null || e.category !== category) && category !== "all"
}

function categoryForCode(code: number | string): string | null {
  const num = parseInt(String(code), 10)
  if (num === 0) return "all"
  if (num === 1) return "bold"
  if (2 < num && num < 5) return "underline"
  if (4 < num && num < 7) return "blink"
  if (num === 8) return "hide"
  if (num === 9) return "strike"
  if ((29 < num && num < 38) || num === 39 || (89 < num && num < 98))
    return "foreground-color"
  if ((39 < num && num < 48) || num === 49 || (99 < num && num < 108))
    return "background-color"
  return null
}

function pushText(text: string, options: Required<FilterOptions>): string {
  return options.escapeXML ? encodeXML(text) : text
}

function pushTag(stack: string[], tag: string, style = ""): string {
  stack.push(tag)
  return `<${tag}${style ? ` style="${style}"` : ""}>`
}

function pushStyle(stack: string[], style: string): string {
  return pushTag(stack, "span", style)
}

function pushForegroundColor(stack: string[], color?: string): string {
  return pushTag(stack, "span", color ? "color:" + color : "")
}

function pushBackgroundColor(stack: string[], color?: string): string {
  return pushTag(stack, "span", color ? "background-color:" + color : "")
}

function closeTag(stack: string[], style: string): string | undefined {
  if (stack.slice(-1)[0] === style) {
    stack.pop()
    return `</${style}>`
  }
  return undefined
}

type TokenCallback = (token: string, data: any) => void

function tokenize(
  text: string,
  options: Required<FilterOptions>,
  callback: TokenCallback
): number[] {
  let ansiMatch = false
  const ansiHandler = 3

  function remove(): string {
    return ""
  }
  function removeXterm256Foreground(_: string, g1: string) {
    callback("xterm256Foreground", g1)
    return ""
  }
  function removeXterm256Background(_: string, g1: string) {
    callback("xterm256Background", g1)
    return ""
  }
  function newline(m: string) {
    if (options.newline) callback("display", -1)
    else callback("text", m)
    return ""
  }
  function ansiMess(_: string, g1: string) {
    ansiMatch = true
    if (g1.trim().length === 0) g1 = "0"
    for (const g of g1.trimEnd().replace(/;$/, "").split(";")) {
      callback("display", g)
    }
    return ""
  }
  function realText(m: string) {
    callback("text", m)
    return ""
  }
  function rgb(m: string) {
    callback("rgb", m)
    return ""
  }

  const tokens = [
    { pattern: /^\x08+/, sub: remove },
    { pattern: /^\x1b\[[012]?K/, sub: remove },
    { pattern: /^\x1b\[\(B/, sub: remove },
    { pattern: /^\x1b\[[34]8;2;\d+;\d+;\d+m/, sub: rgb },
    { pattern: /^\x1b\[38;5;(\d+)m/, sub: removeXterm256Foreground },
    { pattern: /^\x1b\[48;5;(\d+)m/, sub: removeXterm256Background },
    { pattern: /^\n/, sub: newline },
    { pattern: /^\r+\n/, sub: newline },
    { pattern: /^\r/, sub: newline },
    { pattern: /^\x1b\[((?:\d{1,3};?)+|)m/, sub: ansiMess },
    { pattern: /^\x1b\[\d?J/, sub: remove },
    { pattern: /^\x1b\[\d{0,3};\d{0,3}f/, sub: remove },
    { pattern: /^\x1b\[?[\d;]{0,3}/, sub: remove },
    { pattern: /^(([^\x1b\x08\r\n])+)/, sub: realText }
  ]

  function process(
    handler: { pattern: RegExp; sub: (...args: any[]) => string },
    i: number
  ) {
    if (i > ansiHandler && ansiMatch) return
    ansiMatch = false
    text = text.replace(handler.pattern, handler.sub)
  }

  const results: number[] = []
  let { length } = text

  outer: while (length > 0) {
    for (let i = 0; i < tokens.length; i++) {
      const handler = tokens[i]!
      process(handler, i)
      if (text.length !== length) {
        length = text.length
        continue outer
      }
    }
    if (text.length === length) break
    results.push(0)
    length = text.length
  }

  return results
}

function updateStickyStack(
  stickyStack: TokenElement[],
  token: string,
  data: any
): TokenElement[] {
  if (token !== "text") {
    stickyStack = stickyStack.filter(notCategory(categoryForCode(data)))
    stickyStack.push({ token, data, category: categoryForCode(data) })
  }
  return stickyStack
}

export class Filter {
  private options: Required<FilterOptions>
  private stack: string[]
  private stickyStack: TokenElement[]

  constructor(options: FilterOptions = {}) {
    const mergedColors =
      options.colors ?
        Object.assign({}, defaults.colors, options.colors)
      : defaults.colors

    this.options = Object.assign({}, defaults, options, {
      colors: mergedColors
    })
    this.stack = []
    this.stickyStack = []
  }

  toHtml(input: string | string[]): string {
    const inputs = typeof input === "string" ? [input] : input
    const { stack, options } = this
    const buf: string[] = []

    this.stickyStack.forEach((element) => {
      const output = generateOutput(stack, element.token, element.data, options)
      if (output) buf.push(output)
    })

    tokenize(inputs.join(""), options, (token, data) => {
      const output = generateOutput(stack, token, data, options)
      if (output) buf.push(output)
      if (options.stream)
        this.stickyStack = updateStickyStack(this.stickyStack, token, data)
    })

    if (stack.length) buf.push(resetStyles(stack))

    return buf.join("")
  }
}
