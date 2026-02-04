import { Type, type Static } from "typebox"

/**
 * Hook kind identifier.
 *
 * Note: the original type allows arbitrary string values via `(string & {})`,
 * so this is modeled as a plain string with documentation of known values.
 */
export const HookKindSchema = Type.String({
  description: 'Hook kind identifier. Known values: "shell", "bun", "node".'
})
export type HookKind = Static<typeof HookKindSchema>

export const HookConfigSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    run: Type.Union([Type.String(), Type.Array(Type.String())]),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    kind: Type.Optional(HookKindSchema),
    when: Type.Optional(Type.String()),
    continueOnError: Type.Optional(Type.Boolean()),
    timeoutSeconds: Type.Optional(Type.Number())
  },
  { additionalProperties: false }
)
export type HookConfig = Static<typeof HookConfigSchema>

export const StepHooksConfigSchema = Type.Object(
  {
    before: Type.Optional(Type.Array(HookConfigSchema)),
    after: Type.Optional(Type.Array(HookConfigSchema))
  },
  { additionalProperties: false }
)
export type StepHooksConfig = Static<typeof StepHooksConfigSchema>

export const PhaseHooksConfigSchema = Type.Object(
  {
    before: Type.Optional(Type.Array(HookConfigSchema)),
    after: Type.Optional(Type.Array(HookConfigSchema))
  },
  { additionalProperties: false }
)
export type PhaseHooksConfig = Static<typeof PhaseHooksConfigSchema>

export const InstallerHooksConfigSchema = Type.Object(
  {
    build: Type.Optional(PhaseHooksConfigSchema),
    install: Type.Optional(PhaseHooksConfigSchema),
    update: Type.Optional(PhaseHooksConfigSchema)
  },
  { additionalProperties: false }
)
export type InstallerHooksConfig = Static<typeof InstallerHooksConfigSchema>
