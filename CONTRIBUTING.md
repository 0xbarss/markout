# Contributing to markout

Thank you for your interest in contributing to **markout**. This project maintains strict engineering standards to ensure stability, performance, and clean repository history.

Before submitting code, please review the conventions outlined below.

---

## Table of Contents

- [Core Principles](#core-principles)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
  - [Rust Ecosystem](#rust-ecosystem)
  - [TypeScript & Frontend](#typescript--frontend)
  - [Prose and Comment Style](#prose-and-comment-style)
- [Git & Commit Conventions](#git--commit-conventions)
  - [Single-Line Commit Messages](#single-line-commit-messages)
  - [Standard Commit Types](#standard-commit-types)
  - [Prohibited Patterns](#prohibited-patterns)
- [Pull Request Workflow](#pull-request-workflow)
- [Verification Checklist](#verification-checklist)

---

## Core Principles

1. **Just-in-Time Engineering**: Implement only what the immediate task requires. Avoid speculative abstractions, unused dependencies, or boilerplate helpers.
2. **Diff Proportionality**: Keep your changes focused strictly on the requested feature or fix. Do not opportunistically reformat, rename, or refactor unrelated code.
3. **Deterministic Verification**: Every change must include appropriate unit or integration tests verifying happy paths and boundary conditions.
4. **Factual and Direct**: Maintain clear, factual documentation and comments without promotional language or buzzwords.

---

## Development Setup

### Prerequisites

- **Rust**: 1.88 or later with `cargo`, `rustfmt`, and `clippy`.
- **Node.js**: 22.18 or later with `npm`.

### Initial Build

```bash
# 1. Clone repository
git clone https://github.com/0xbarss/markout.git
cd markout

# 2. Build web assets (required before compiling the binary)
cd web
npm install
npm run build
cd ..

# 3. Build and test the Rust binary
cargo test
cargo build
```

### Local Development Workflow

Run the Rust server and the Vite dev server in parallel:

```bash
# Terminal 1: Run backend with sample dataset
cargo run -- --bars examples/bars.csv --trades examples/trades.jsonl

# Terminal 2: Run frontend with hot reloading
cd web
npm run dev
```

The Vite development server runs at `http://localhost:5173` and proxies `/api` and `/ws` requests to `127.0.0.1:8080`.

---

## Coding Standards

### Rust Ecosystem

- **Formatting**: Code must be formatted using `cargo fmt`. Check with:
  ```bash
  cargo fmt --check
  ```
- **Linting**: All code must pass `clippy` with zero warnings:
  ```bash
  cargo clippy --all-targets -- -D warnings
  ```
- **Dependencies**: Prefer the standard library or existing dependencies before adding new external crates.
- **Error Handling**: Use typed errors via `thiserror` for library modules and `anyhow` for binary orchestration. Avoid bare `.unwrap()` or `.expect()` calls in library code.

### TypeScript & Frontend

- **Strict Type Checking**: Compiles with strict mode enabled (`"strict": true`).
- **No `any`**: Explicit or implicit `any` is prohibited. Use `unknown` with runtime type narrowing for dynamic data.
- **Naming Conventions**:
  - `camelCase` for variables, properties, and functions.
  - `PascalCase` for types, interfaces, and classes.
  - `SCREAMING_SNAKE_CASE` for module constants.
  - `kebab-case` for file names (`style-utils.ts`), except when a file's sole export is a class matching its name (`ReplayController.ts`).

### Prose and Comment Style

- **Realistic & Factual**: Avoid buzzwords, marketing claims, and promotional adjectives (e.g. "blazing-fast", "ultra lightweight", "seamless", "robust", "optimal").
- **No Obvious Chatter**: Do not write comments that restate what the code already shows.
- **Doc Comments**: Use `///` or `/** */` only on public exported interfaces to explain non-obvious constraints, invariants, or edge cases.

---

## Git & Commit Conventions

### Single-Line Commit Messages

All commit messages **MUST be a single line**:

```text
<type>(<scope>): <subject>
# or
<type>: <subject>
```

- **No Commit Bodies**: Never provide multi-line bodies, bulleted lists, or explanatory paragraphs in commit messages. Detailed context belongs in the Pull Request description.
- **Imperative & Lowercase**: Start the subject with a lowercase imperative verb (e.g., `feat: implement parquet ingestion`, not `feat: Implemented Parquet Ingestion`). Do not end with a period.
- **Character Limit**: Keep the subject at or under **72 characters**.

### Standard Commit Types

| Type | Purpose | Example |
| :--- | :--- | :--- |
| `feat` | New feature or engine capability | `feat(ingest): add parquet trade loader` |
| `fix` | Bug fix or edge case patch | `fix(resample): prevent bucket off-by-one error` |
| `test` | Unit, integration, or property tests | `test(replay): add speed multiplier transition tests` |
| `refactor` | Structural improvement with no behavior change | `refactor(server): extract static asset handler` |
| `build` | Build scripts, dependencies, or manifests | `build(web): update vite and typescript dependencies` |
| `ci` | CI workflow or pipeline configuration | `ci: add clippy check to verification workflow` |
| `style` | Formatting or whitespace adjustments only | `style: run cargo fmt across ingestion module` |
| `perf` | Performance optimizations | `perf(canvas): batch path draw calls in trail layer` |
| `docs` | Documentation and specification updates | `docs: add CONTRIBUTING.md guide` |
| `chore` | Routine housekeeping or generated asset refreshes | `chore: update sample datasets` |

Breaking changes must be flagged with `!` before the colon (e.g., `feat(api)!: remove v0 deprecated endpoint`).

### Prohibited Patterns

- ❌ Multi-line commit messages or commit bodies.
- ❌ AI references, prompt citations, or session IDs in commit subjects.
- ❌ Vague commit messages (`wip`, `update code`, `fix bugs`).
- ❌ Untracked or tracked local scratch files (`SESSION_PROGRESS.md`, `.agent/`, prompt files).

---

## Pull Request Workflow

1. **Branch Naming**: Create a branch with format `<type>/<short-description>`:
   ```bash
   git checkout -b feat/add-tick-replay-filter
   ```
2. **Keep PRs Focused**: Target fewer than 400 changed lines (excluding lockfiles and compiled assets). Split larger changes into discrete incremental pull requests.
3. **Self-Review**: Review your own diff top to bottom prior to opening the PR to clean up debug logs, unused imports, or leftover notes.
4. **Description**: Use the pull request description to explain motivation, design rationale, and test procedures.

---

## Verification Checklist

Before submitting a pull request, ensure:

- [ ] `cargo test` passes cleanly.
- [ ] `cd web && npm test` passes cleanly.
- [ ] `cargo fmt --check` reports no formatting differences.
- [ ] `cargo clippy --all-targets -- -D warnings` emits zero warnings.
- [ ] TypeScript compiles cleanly via `cd web && npm run build`.
- [ ] Every commit message is a single line under 72 characters following the conventional commit specification.
- [ ] No temporary files or secrets are staged.
