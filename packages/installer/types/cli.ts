import { Type, type Static } from "typebox"
import { FieldPathSchema } from "./core"

export const CliPromptKindSchema = Type.Union(
  [
    Type.Literal("input"),
    Type.Literal("password"),
    Type.Literal("confirm"),
    Type.Literal("select"),
    Type.Literal("multiselect"),
    Type.Literal("number"),
    Type.Literal("path"),
    Type.Literal("textarea")
  ],
  { description: "CLI prompt kind." }
)
export type CliPromptKind = Static<typeof CliPromptKindSchema>

export const CliChoiceSchema = Type.Object(
  {
    value: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    hint: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)
export type CliChoice = Static<typeof CliChoiceSchema>

export const CliPromptConfigBaseSchema = Type.Object(
  {
    /**
     * Field this prompt writes to — should match the form field path.
     * Example: "app.domain"
     */
    name: FieldPathSchema,
    /**
     * Message shown in CLI. If omitted, you can fall back to the form label.
     */
    message: Type.Optional(Type.String()),
    /**
     * Help text under the prompt / via "more info".
     */
    help: Type.Optional(Type.String()),
    /**
     * Mark as sensitive (no echo).
     */
    secret: Type.Optional(Type.Boolean()),
    /**
     * Default if user just presses Enter.
     */
    default: Type.Optional(Type.Unknown()),
    /**
     * Basic required flag.
     */
    required: Type.Optional(Type.Boolean()),
    /**
     * Optional condition to skip this prompt.
     * You can interpret as an expression or callback id.
     */
    when: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)
export type CliPromptConfigBase = Static<typeof CliPromptConfigBaseSchema>

const CliInputKindSchema = Type.Union(
  [
    Type.Literal("input"),
    Type.Literal("password"),
    Type.Literal("number"),
    Type.Literal("path"),
    Type.Literal("textarea")
  ],
  {
    description: 'Prompt kinds excluding "confirm" | "select" | "multiselect".'
  }
)

export const CliInputPromptSchema = Type.Intersect(
  [
    CliPromptConfigBaseSchema,
    Type.Object(
      {
        kind: Type.Optional(CliInputKindSchema)
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
)
export type CliInputPrompt = Static<typeof CliInputPromptSchema>

export const CliConfirmPromptSchema = Type.Intersect(
  [
    CliPromptConfigBaseSchema,
    Type.Object(
      {
        kind: Type.Literal("confirm"),
        default: Type.Optional(Type.Boolean())
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
)
export type CliConfirmPrompt = Static<typeof CliConfirmPromptSchema>

export const CliSelectPromptSchema = Type.Intersect(
  [
    CliPromptConfigBaseSchema,
    Type.Object(
      {
        kind: Type.Union([Type.Literal("select"), Type.Literal("multiselect")]),
        choices: Type.Array(CliChoiceSchema)
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
)
export type CliSelectPrompt = Static<typeof CliSelectPromptSchema>

export const CliPromptConfigSchema = Type.Union(
  [CliInputPromptSchema, CliConfirmPromptSchema, CliSelectPromptSchema],
  { description: "Union of supported CLI prompt configurations." }
)
export type CliPromptConfig = Static<typeof CliPromptConfigSchema>

export const StepCliConfigSchema = Type.Object(
  {
    /**
     * CLI prompts for this step.
     * If omitted, you can auto-generate from the FormKit schema.
     */
    prompts: Type.Optional(Type.Array(CliPromptConfigSchema))
  },
  { additionalProperties: false }
)
export type StepCliConfig = Static<typeof StepCliConfigSchema>

export const CliModeSchema = Type.Union([
  Type.Literal("cli"),
  Type.Literal("web")
])
export type CliMode = Static<typeof CliModeSchema>

export const LogTargetSchema = Type.Union([
  Type.Literal("stdout"),
  Type.Literal("file"),
  Type.Literal("both")
])
export type LogTarget = Static<typeof LogTargetSchema>

export const LogLevelSchema = Type.Union([
  Type.Literal("fatal"),
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
  Type.Literal("debug"),
  Type.Literal("trace"),
  Type.Literal("silent")
])
export type LogLevel = Static<typeof LogLevelSchema>

export const CliRuntimeOptionsSchema = Type.Object(
  {
    mode: CliModeSchema,
    port: Type.Number(),
    logging: LogTargetSchema,
    logs_dir: Type.String(),
    log_level: LogLevelSchema
  },
  { additionalProperties: false }
)
export type CliRuntimeOptions = Static<typeof CliRuntimeOptionsSchema>

export const FormKitCliMetaSchema = Type.Object(
  {
    kind: Type.Optional(CliPromptKindSchema),
    message: Type.Optional(Type.String()),
    help: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.Unknown()),
    when: Type.Optional(Type.String()),
    secret: Type.Optional(Type.Boolean()),
    choices: Type.Optional(Type.Array(CliChoiceSchema))
  },
  { additionalProperties: false }
)
export type FormKitCliMeta = Static<typeof FormKitCliMetaSchema>
