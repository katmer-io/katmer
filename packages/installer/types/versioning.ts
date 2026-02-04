import { Type, type Static } from "typebox"

/**
 * Versioning strategy kind.
 *
 * Note: the original type allows arbitrary string values via `(string & {})`,
 * so this is modeled as a string with documentation of known values.
 */
export const VersioningStrategyKindSchema = Type.String({
  description:
    'Versioning strategy kind. Known values: "semver", "numeric", "lexicographic", or a custom id.'
})
export type VersioningStrategyKind = Static<typeof VersioningStrategyKindSchema>

export const VersioningStrategyConfigSchema = Type.Object(
  {
    /**
     * How to compare versions when deciding "latest".
     */
    kind: Type.Optional(VersioningStrategyKindSchema),

    /**
     * If true, higher value wins (default for semver/numeric).
     * If false, lower value wins.
     */
    ascending: Type.Optional(Type.Boolean()),

    /**
     * Optional pattern to normalize raw version strings before comparison.
     */
    normalizePattern: Type.Optional(Type.String()),

    /**
     * For custom strategies: an implementation id your runtime resolves.
     */
    customComparatorId: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)
export type VersioningStrategyConfig = Static<
  typeof VersioningStrategyConfigSchema
>
