import nodeCrypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { CONFIG } from "../config"

export type ElmLicense = {
  license_key: string
  parameter_settings: {
    hardware_id?: string
    product_id?: string
  }
  packet: {
    packet_name: string
    packet_code: string
  }[]
  application_name: string
  client: {
    client_number: string
    client_name: string
  }
  license_start_at: string // ISO 8601 date-time string
  license_end_at: string // ISO 8601 date-time string
  metadata: Record<string, any>
}

export const ElmService = {
  async retrieveLicenseContext() {
    // TODO: generate csr
    // const sys = await sysinfo.getStaticData()
    return btoa(
      JSON.stringify({
        product_id: getProductId(),
        hostname: `sys.os.hostname`,
        ipv_4: `sys.net.at(0)?.ip4`,
        access_key: nodeCrypto.randomUUID(),
        api_key: CONFIG.licensing.key,
        operating_system: 3
      })
    )
  },

  elmLicenseToSubscription(content: ElmLicense) {
    return {
      metadata: {
        ...content.parameter_settings,
        client_number: content.client.client_number,
        license_id: content.license_key
      },
      plan: "on-premise",
      plan_details: content.metadata || ({} as any),
      issued_at: new Date(content.license_start_at).toISOString(),
      expires_at: new Date(content.license_end_at).toISOString()
    }
  },
  async requestLicense(csrText: string) {
    const formdata = new FormData()

    formdata.append(
      "license",
      new File([csrText], "license.csr", { type: "text/plain" }),
      "license.csr"
    )

    try {
      const rawResp = await fetch(
        `${CONFIG.licensing.server_url}/license/l-upload`,
        {
          method: "POST",
          headers: {
            api_key: nodeCrypto.randomUUID()
          },
          body: formdata,
          redirect: "follow"
        }
      )
      return await rawResp.json()
    } catch (e) {
      console.error(e)
      return false
    }
  }
}

function removeHeaders(cert?: string | Buffer | null) {
  if (!cert) {
    return
  }
  const pem = /-----BEGIN((\s?\w*)*)-----([^-]*)-----END((\s?\w*)*)-----/g.exec(
    cert.toString()
  )
  if (pem && pem.length > 0) {
    return pem[3].replace(/[\n|\r\n]/g, "")
  }
  return null
}

function getProductId() {
  const pidPath = path.resolve(CONFIG.licensing.pid_dir, "product-id")
  let existingId: string
  try {
    existingId = fs.readFileSync(pidPath, { encoding: "utf-8" })
    if (!existingId.trim()) {
      throw new Error("not found")
    }
  } catch (e) {
    existingId = process.env.PLUSAUTH_PRODUCT_ID || nodeCrypto.randomUUID()
    if (!fs.existsSync(path.dirname(pidPath))) {
      fs.mkdirSync(path.dirname(pidPath), { recursive: true })
    }
    fs.writeFileSync(pidPath, existingId, { encoding: "utf-8", flag: "w" })
  }
  return existingId.trim()
}

function removeAlgFromHeader(cert: string | Buffer) {
  return cert
    .toString()
    .replace(/BEGIN(.*)?PUBLIC KEY/, "BEGIN PUBLIC KEY")
    .replace(/END(.*)?PUBLIC KEY/, "END PUBLIC KEY")
}
