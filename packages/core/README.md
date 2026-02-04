# Katmer Core (Rust)

This package contains the high-performance Rust implementation of the Katmer core execution engine.

## Node.js bindings

This package also ships Node.js bindings (N-API via napi-rs).

Build the native addon:

```bash
bun run build
```

Basic usage:

```ts
import { KatmerCore } from "@katmer/core"

const core = new KatmerCore({ cwd: process.cwd(), target: [] })
await core.loadConfig({
  targets: {
    hosts: {
      local: { connection: "local" },
    },
  },
})

await core.check()
// await core.run("./tasks.yaml")
```

Windows note: `vendored-openssl` builds require a Perl distribution with standard CPAN modules (Strawberry Perl works).

## Examples

We've included several examples to help you get started with the Rust core.

### Debian VM Setup

This example demonstrates how to use the SSH provider to manage a remote Debian VM.

**Files:**
- [targets.yaml](examples/debian-vm/targets.yaml)
- [tasks.yaml](examples/debian-vm/tasks.yaml)

**Running the example:**

1. Build the core:
   ```bash
   cargo build --release
   ```

2. Execute the tasks:
   ```bash
   ./target/release/katmer -t ./examples/debian-vm/targets.yaml run ./examples/debian-vm/tasks.yaml
   ```

**Features demonstrated:**
- **SSH Connectivity**: Securely connect to remote hosts.
- **Interactive Sudo**: Handles `sudo` password prompts automatically using PTY.
- **Fact Gathering**: Automatically collects system information (OS, kernel, arch).
- **Persistent State**: Variables and facts persist across multiple tasks for the same host.

### Variable Persistence & Facts

To verify that the inventory is working correctly and state is maintained:

```bash
# Run the persistence test
./target/release/katmer run test_persistence.yaml
```

## Running Tasks

The `katmer` CLI follows this syntax:

```bash
katmer [global-options] run <task-file> [task-options]
```

**Common Options:**
- `-t, --targets <file>`: Path to the targets configuration file.
- `-v, --verbose`: Increase logging output.
