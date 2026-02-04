import type { ErrorObject } from "ajv"

export function normalizeAjvError(error: ErrorObject): string {
  let message: string
  error.message = error.message?.toLowerCase()
  const objPath = error.instancePath?.replace("/", "").replaceAll("/", ".")

  if (error.keyword === "pattern") {
    message = `"${objPath}" contains invalid characters`
  } else if (error.message?.startsWith("must ") && error.instancePath!.length) {
    message = `"${objPath || ""}" ${error.message}`
  } else {
    message = error.message!
  }

  if (
    error.keyword === "additionalProperties" &&
    error.params?.additionalProperty
  ) {
    message = `${message}: "${error.params.additionalProperty}"`
  }

  return message
}
