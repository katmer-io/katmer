const xmlCodeMap = new Map([
  [34, "&quot;"],
  [38, "&amp;"],
  [39, "&apos;"],
  [60, "&lt;"],
  [62, "&gt;"]
])
export const XML_BITSET_VALUE = 0x50_00_00_c4 // 32..63 -> 34 ("),38 (&),39 ('),60 (<),62 (>)
const getCodePoint = (c: string, index: number): number =>
  (c.charCodeAt(index) & 0xfc_00) === 0xd8_00 ?
    (c.charCodeAt(index) - 0xd8_00) * 0x4_00 +
    c.charCodeAt(index + 1) -
    0xdc_00 +
    0x1_00_00
  : c.charCodeAt(index)

export function encodeXML(input: string): string {
  let out: string | undefined
  let last = 0
  const { length } = input

  for (let index = 0; index < length; index++) {
    const char = input.charCodeAt(index)

    // Check for ASCII chars that don't need escaping
    if (
      char < 0x80 &&
      (((XML_BITSET_VALUE >>> char) & 1) === 0 || char >= 64 || char < 32)
    ) {
      continue
    }

    if (out === undefined) out = input.substring(0, index)
    else if (last !== index) out += input.substring(last, index)

    if (char < 64) {
      // Known replacement
      out += xmlCodeMap.get(char)!
      last = index + 1
      continue
    }

    // Non-ASCII: encode as numeric entity (handle surrogate pair)
    const cp = getCodePoint(input, index)
    out += `&#x${cp.toString(16)};`
    if (cp !== char) index++ // Skip trailing surrogate
    last = index + 1
  }

  if (out === undefined) return input
  if (last < length) out += input.substr(last)
  return out
}
