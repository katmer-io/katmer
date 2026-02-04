export function removeHeaders(cert?: string | Buffer | null) {
  if (!cert) {
    return
  }
  const pem = /-----BEGIN((\s?\w*)*)-----([^-]*)-----END((\s?\w*)*)-----/g.exec(
    cert.toString()
  )
  if (pem && pem.length > 0) {
    return pem[3].replace(/[\n|\r\n]/g, "")
  }
  return cert.toString().replace(/[\n|\r\n]/g, "")
}

export function removeAlgFromPublicKey(pem: string | Buffer) {
  return pem
    .toString()
    .replace(/BEGIN(.*)?PUBLIC KEY/, "BEGIN PUBLIC KEY")
    .replace(/END(.*)?PUBLIC KEY/, "END PUBLIC KEY")
}

export function extractPemCertificates(str: string) {
  if (!str) {
    return []
  }
  // Regular expression to match PEM-encoded certificates with headers and footers
  const pemRegex =
    /(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/g

  // Match all occurrences of the PEM blocks with headers and footers
  const pemCertificates = str.match(pemRegex)

  // Return the array of PEM certificates or an empty array if no match is found
  return pemCertificates || []
}

export function extractPemPrivateKey(str: string) {
  if (!str) {
    return []
  }
  const pemRegex =
    /(-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----[\s\S]+?-----END \2-----)/g

  // Match all occurrences of the PEM blocks with headers and footers
  const pemCertificates = str.match(pemRegex)

  // Return the array of PEM certificates or an empty array if no match is found
  return pemCertificates || []
}
