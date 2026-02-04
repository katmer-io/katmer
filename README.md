<div align="center">
    <a href="https://katmer-io.github.io/katmer/" target="_blank">
      <img src="assets/logo.svg" alt="Katmer Logo" width="320px" style="margin-top: 24px;" />
    </a>
    <p style="font-size: 24px"><strong>Manage your infrastructure with ease</strong></p>
</div>

> [!CAUTION]
> katmer is currently in **alpha**. This project is still in early development. Interfaces, schemas, and behavior
> may change without notice.
>
> **Do not use in production** yet.
>
> Feedback and early experimentation are welcome.

## What is katmer?

**katmer** (named after the traditional Turkish layered dessert, from the word *"kat"*
meaning "layer", pronounced /kaˈtmer/) is a modular infrastructure management framework
designed to simplify how infrastructure is defined, composed, and executed.

It emphasizes building systems from clear, reusable layers that adapt across operating systems, architectures, and
environments.

## Features

- **Modular Design**: Compose infrastructure from reusable, versioned modules
- **Multi-Platform**: Support for various operating systems and architectures
- **Type-Safe Configuration**: Strong typing with runtime validation
- **Beautiful Installation Experience**: Auto-generated UI from configuration schemas
- **Extensible**: Plugin system for custom functionality

## Getting Started

To explore the Rust implementation and see it in action with real-world examples (including remote SSH management), check out the [Core Package Documentation](packages/core/README.md).

### Try the Examples
We've prepared a ready-to-use setup for a Debian VM:
- [Debian VM Example](packages/core/examples/debian-vm/)
- [Variable Persistence Demo](packages/core/test_persistence.yaml)


