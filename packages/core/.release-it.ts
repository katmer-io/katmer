import type { Config } from "release-it"
import { resolve } from "node:path"

const packagePath = process.cwd()

export default {
  git: {
    requireBranch: "main",
    tagName: "v${version}",
    commitMessage: "chore(release): core v${version}",
    addUntrackedFiles: false,
    commit: true,
    push: true,
    requireCleanWorkingDir: false
  },

  npm: {
    publish: true,
    publishArgs: ["--access=public", "--workspaces-update=false"],
    publishPath: ".",
    skipChecks: !!process.env.CI,
    versionArgs: ["--workspaces-update=false"]
  },

  github: {
    release: true,
    releaseName: "katmer-core v${version}"
  },

  hooks: {
    "after:bump": "node scripts/release-it/sync-versions.mjs",
    "before:bump": "bun run build && bun run artifacts"
  },

  plugins: {
    "@release-it/conventional-changelog": {
      commitsOpts: {
        path: [packagePath]
      },
      gitRawCommitsOpts: {
        path: [packagePath]
      },
      preset: "conventionalcommits",
      infile: resolve(packagePath, "CHANGELOG.md"),
      preMajor: true
    }
  }
} satisfies Config
