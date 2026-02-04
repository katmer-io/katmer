import { Type, type Static } from "typebox"

/**
 * What to fetch and bundle into the installer executable during build.
 * These refer to logical sources by id.
 */
export const BuildPayloadConfigSchema = Type.Object(
  {
    /**
     * Id of the source (must match DistributionConfig.sources[].id).
     */
    sourceId: Type.String(),
    /**
     * Version/label to lock this payload to at build time.
     */
    version: Type.Optional(Type.String()),
    /**
     * Glob patterns (relative to source root) to include in the bundle.
     */
    include: Type.Optional(Type.Array(Type.String())),
    /**
     * Glob patterns to exclude.
     */
    exclude: Type.Optional(Type.Array(Type.String())),
    /**
     * Destination path inside the installer virtual filesystem.
     * Example: "payload/myApp"
     */
    destination: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)
export type BuildPayloadConfig = Static<typeof BuildPayloadConfigSchema>

/**
 * Build-time configuration.
 * Your "installer generator" reads this first to know what to bundle.
 */
export const BuildConfigSchema = Type.Object(
  {
    /**
     * Payloads to fetch from sources and package into the executable.
     */
    payloads: Type.Optional(Type.Array(BuildPayloadConfigSchema)),
    /**
     * Optional version the installer is being built for.
     * If omitted, use InstallerConfig.version.
     */
    targetVersion: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)
export type BuildConfig = Static<typeof BuildConfigSchema>
