import type { Config } from "release-it"
import { resolve } from "node:path"

const packagePath = resolve(process.cwd(), "packages/core")

export default {
  git: {
    requireBranch: "main",
    tagName: "v${version}",
    commitMessage: "chore(release): katmer v${version}",
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
    releaseName: "v${version}",
    assets: ["dist/releases/*"]
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
      infile: "CHANGELOG.md",
      preMajor: true
    }
  }
} satisfies Config
