import * as jsrs from "jsrsasign"
import isEmail from "validator/lib/isEmail"
import isFQDN from "validator/lib/isFQDN"
import {
  extractPemCertificates,
  extractPemPrivateKey,
  removeHeaders
} from "./utils/certificate.utils"

export const Validators = {
  async privateKey(
    value: any,
    params: {
      certificate: string
      domain?: string | string[]
    }
  ) {
    if (typeof value !== "string" || !value) {
      throw "must be file/string"
    }
    const keys = extractPemPrivateKey(value)

    if (keys.length === 0) {
      throw "no private keys provided"
    }
    if (keys.length > 1) {
      throw "multiple private keys found"
    }
    const [keyPem] = keys
    let key
    try {
      key = jsrs.KEYUTIL.getKey(keyPem)

      const certificates = await Validators.certificate(
        params.certificate,
        params
      )

      for (const { x509 } of certificates) {
        const pub = x509.getPublicKey() as any
        if (!pub.n.equals((key as any).n)) {
          throw "certificate public key mismatch"
        }
      }
    } catch (e) {
      throw typeof e === "string" ? e : "invalid private key provided."
    }

    return { privateKey: key, pem: keyPem }
  },
  async certificate(value: any, params: { domain?: string | string[] } = {}) {
    if (typeof value !== "string" || !value) {
      throw "must be file/string"
    }

    const certificates: { x509: jsrs.X509; pem: string }[] = []
    const PEMs = extractPemCertificates(value)

    if (PEMs.length === 0) {
      throw "no valid certificates provided"
    }
    const subjectsToCheck = (
      Array.isArray(params.domain) ?
        params.domain
      : [params.domain]).filter(Boolean)

    let subjectFound = false
    try {
      for (const certContent of PEMs) {
        const x509 = new jsrs.X509()
        x509.readCertPEM(certContent)
        // throw early when certificate is invalid
        x509.getIssuerString()
        certificates.push({ x509: x509, pem: certContent })

        if (!subjectFound && subjectsToCheck.length > 0) {
          const values = new Set([
            ...x509
              .getSubject()
              .array.flat()
              .map((s) => s.value),
            ...(x509
              .getExtSubjectAltName()
              ?.array.flatMap(Object.values as any) || [])
          ])

          // do not keep checking if one of certificates passes subject check
          subjectFound = subjectsToCheck.some((sub) => values.has(sub))
        }
      }
    } catch (e) {
      throw `invalid certificate${PEMs.length > 1 ? "s" : ""} provided`
    }

    if (subjectsToCheck.length > 0 && !subjectFound) {
      throw `at least one certificate must be issued for ${subjectsToCheck.join(", ")}`
    }

    return certificates
  },
  password(value?: string) {
    if (typeof value !== "string") {
      throw "must be string"
    }
    if (value.length < 8) {
      throw "must be at least 8 characters"
    }
    if (!/[0-9]/.test(value)) {
      throw "must contain at least one number"
    }
    if (!/[a-zA-Z]/.test(value)) {
      throw "must contain at least one character"
    }
    return true
  },
  domain(value?: string) {
    if (typeof value !== "string") {
      throw "must be string"
    }
    if (
      !isFQDN(value, {
        require_tld: true,
        allow_trailing_dot: false,
        allow_wildcard: false,
        allow_underscores: true,
        allow_numeric_tld: false
      })
    ) {
      throw "must be valid domain"
    }
    return true
  },
  license(license_content?: string) {
    if (!license_content) {
      throw "must be file or string"
    }
    const plainContent = removeHeaders(license_content)
    if (!plainContent) throw "invalid license content"
    try {
      const parsedContent = JSON.parse(atob(plainContent))
      return !!parsedContent
    } catch {
      throw "invalid license content"
    }
  },
  license_signature(signature?: string) {
    if (!signature) {
      throw "must be file or string"
    }
    const plainContent = removeHeaders(signature) || signature
    if (!plainContent) throw "invalid signature"
    return true
  },
  email(value?: string) {
    if (typeof value !== "string") {
      throw "must be string"
    }
    if (!isEmail(value, { allow_underscores: true })) {
      throw "must be valid email address"
    }
    return true
  }
}
