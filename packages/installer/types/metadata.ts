import { Type, type Static } from "typebox"

// types/metadata.ts

/**
 * Describes a single migration step between two versions of a product.
 * Migration definitions are discovered from external metadata files,
 * not from the installer configuration itself.
 */
export const MigrationStepDescriptorSchema = Type.Object(
  {
    /**
     * Target version reached after this migration is applied.
     */
    to: Type.String(),
    /**
     * Source version or version range from which this migration is applicable.
     */
    from: Type.Optional(Type.String()),
    /**
     * Command or command sequence that performs the migration.
     */
    run: Type.Union([Type.String(), Type.Array(Type.String())]),
    /**
     * Human-readable description that can be displayed in logs or UI.
     */
    description: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)
export type MigrationStepDescriptor = Static<
  typeof MigrationStepDescriptorSchema
>

// ---------- INSTALLATION RUNTIME ----------

/**
 * Identifies the runtime technology responsible for executing installation
 * and upgrade logic contained in a release.
 *
 * Note: the original type allows arbitrary string values via `(string & {})`,
 * so this is modeled as a string with documentation of known values.
 */
export const InstallerRuntimeKindSchema = Type.String({
  description:
    'Installer runtime kind. Known values: "katmer", "ansible", "terraform" (plus custom ids).'
})
export type InstallerRuntimeKind = Static<typeof InstallerRuntimeKindSchema>

/**
 * Base configuration for a runtime executor that manages install/upgrade operations.
 */
export const InstallerRuntimeBaseSchema = Type.Object(
  {
    /**
     * Runtime implementation identifier (for example "katmer" or "terraform").
     */
    kind: InstallerRuntimeKindSchema,
    /**
     * Logical identifier used to distinguish between multiple runtime definitions.
     */
    id: Type.Optional(Type.String()),
    /**
     * Human-readable description of the runtime configuration.
     */
    description: Type.Optional(Type.String()),
    /**
     * Arbitrary runtime-specific settings.
     */
    options: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  },
  { additionalProperties: true }
)
export type InstallerRuntimeBase = Static<typeof InstallerRuntimeBaseSchema>

export const KatmerInstallerRuntimeConfigSchema = Type.Intersect(
  [
    InstallerRuntimeBaseSchema,
    Type.Object(
      {
        kind: Type.Literal("katmer"),
        /**
         * Relative path within the release payload to the primary Katmer configuration file.
         */
        configPath: Type.String(),
        /**
         * Optional identifier of the entry target or task defined in the Katmer configuration.
         */
        entryTargetId: Type.Optional(Type.String())
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
)
export type KatmerInstallerRuntimeConfig = Static<
  typeof KatmerInstallerRuntimeConfigSchema
>

export const AnsibleInstallerRuntimeConfigSchema = Type.Intersect(
  [
    InstallerRuntimeBaseSchema,
    Type.Object(
      {
        kind: Type.Literal("ansible"),
        /**
         * Relative path within the payload to the primary Ansible playbook file.
         */
        playbookPath: Type.String(),
        /**
         * Optional relative path to an Ansible inventory file.
         */
        inventoryPath: Type.Optional(Type.String())
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
)
export type AnsibleInstallerRuntimeConfig = Static<
  typeof AnsibleInstallerRuntimeConfigSchema
>

export const TerraformInstallerRuntimeConfigSchema = Type.Intersect(
  [
    InstallerRuntimeBaseSchema,
    Type.Object(
      {
        kind: Type.Literal("terraform"),
        /**
         * Relative path within the payload to the root Terraform module directory.
         */
        rootModulePath: Type.String()
      },
      { additionalProperties: false }
    )
  ],
  { additionalProperties: false }
)
export type TerraformInstallerRuntimeConfig = Static<
  typeof TerraformInstallerRuntimeConfigSchema
>

export const CustomInstallerRuntimeConfigSchema = Type.Intersect(
  [InstallerRuntimeBaseSchema, Type.Record(Type.String(), Type.Unknown())],
  { additionalProperties: true }
)

/**
 * Union type covering all supported installer runtime configurations.
 */
export const InstallerRuntimeConfigSchema = Type.Union(
  [
    KatmerInstallerRuntimeConfigSchema,
    AnsibleInstallerRuntimeConfigSchema,
    TerraformInstallerRuntimeConfigSchema,
    CustomInstallerRuntimeConfigSchema
  ],
  { description: "Installer runtime configuration." }
)
export type InstallerRuntimeConfig = Static<typeof InstallerRuntimeConfigSchema>

// ---------- DEPENDENCIES ----------

/**
 * Describes a dependency that must be present or satisfied for a given release.
 */
export const DependencyConstraintSchema = Type.Object(
  {
    /**
     * Logical identifier of the dependency.
     */
    id: Type.String(),
    /**
     * Human-readable label suitable for display in UI.
     */
    label: Type.Optional(Type.String()),
    /**
     * Version constraint expression interpreted according to the configured versioning strategy.
     */
    versionConstraint: Type.Optional(Type.String()),
    /**
     * Indicates whether the dependency is optional.
     */
    optional: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)
export type DependencyConstraint = Static<typeof DependencyConstraintSchema>

// ---------- INSTALLER METADATA ----------

export const InstallerEntrypointSchema = Type.Object(
  {
    kind: Type.Optional(
      Type.String({
        description:
          'Known values: "shell", "bun", "node", "command" (plus custom ids).'
      })
    ),
    path: Type.String(),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)

/**
 * Metadata describing a specific installer release and its associated payload.
 *
 * Note: this type has an extension index signature (`[key: string]: unknown`),
 * so additional properties are allowed.
 */
export const InstallerMetadataSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    version: Type.String(),
    channel: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    /**
     * ISO 8601 timestamp indicating when this release was produced.
     */
    releaseDate: Type.Optional(Type.String()),
    runtime: Type.Optional(InstallerRuntimeConfigSchema),
    entrypoint: Type.Optional(InstallerEntrypointSchema),
    dependencies: Type.Optional(Type.Array(DependencyConstraintSchema)),
    migrations: Type.Optional(Type.Array(MigrationStepDescriptorSchema))
  },
  { additionalProperties: Type.Unknown() }
)
export type InstallerMetadata = Static<typeof InstallerMetadataSchema>
