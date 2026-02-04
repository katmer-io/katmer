import { Type, type Static } from "typebox"

/**
 * Path-like name for a field.
 * Examples: "app.domain", "app.admin.email"
 */
export const FieldPathSchema = Type.String({
  description:
    'Path-like name for a field. Examples: "app.domain", "app.admin.email".'
})

export type FieldPath = Static<typeof FieldPathSchema>
