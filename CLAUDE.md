# CLAUDE.md

## Project Overview

Obsidian CouchDB Sync — a community plugin for [Obsidian](https://obsidian.md) that provides live, end-to-end encrypted synchronization between an Obsidian vault and a self-hosted CouchDB server via PouchDB.

Plugin ID: `couchdb-sync`

## Architecture

### Source Layout

```
src/
  main.ts        Plugin entry point (extends Obsidian Plugin class)
  settings.ts    Settings tab: embeds the panel, then the settings themselves
  indexpanel.ts  Shared status panel: status card, state lists, file tree, actions
  view.ts        Right-sidebar view (ItemView) hosting the same panel
  engine.ts      Core sync engine (indexing, upload, download, conflict resolution)
  database.ts    PouchDB/CouchDB abstraction, CORS-free fetch via Obsidian requestUrl
  crypto.ts      AES-256-GCM end-to-end encryption (PBKDF2 key derivation)
  secrets.ts     Credential sealing: keeps password/passphrase out of data.json
  secretsmodal.ts  Passphrase prompt for the "ask at every launch" credential mode
  envelope.ts    Engine <-> wire form: metadata-private document envelope
  history.ts     File version history UI (diff viewer, restore modal)
  diffmerge.ts   Side-by-side diff & merge editor for divergent files
  migrate.ts     One-time settings migrations (pure, gated by schemaVersion)
  types.ts       Shared types, constants, default settings
  util.ts        Pure utility functions (hashing, base64, binary detection, diff)
```

### Key Design Decisions

- **Content-addressed chunking**: File content is split into 1 MiB chunks (`CHUNK_SIZE`). Chunks are immutable and keyed by hash (`h:<hash>`), so identical content is stored once.
- **Document prefixes**: File docs use `f:<path>`, chunks use `h:<hash>`, history uses `H:<path>\n<timestamp>\n<hash>`. Prefixes enable efficient range queries without loading chunk data into memory.
- **CORS bypass**: `database.ts` wraps Obsidian's `requestUrl()` as a fetch implementation for PouchDB, avoiding CORS issues on desktop and mobile.
- **Vault isolation**: Each vault gets a unique `localDbId` so PouchDB databases never collide, even for vaults with the same name.
- **Five-state file classification**: synced, local-only, remote-only, drift (content differs, no conflict), conflict (concurrent edits). Severity-based folder rollup in the UI.
- **No credentials in `data.json`**: the CouchDB password and the E2EE passphrase are runtime-only fields on the settings object. `saveSettings` seals them into `encryptedSecrets` and deletes the plain keys from the persisted copy; `loadSettings` restores them. The key lives outside the vault (device-local storage, or a passphrase asked per launch), so a copied/backed-up vault carries no usable credentials. Invariant: **while the blob cannot be read, saving must pass the stored blob through untouched** — the crash guard and teardown both save before/without an unlock, and re-sealing empty credentials there would destroy them.

### Module Boundaries

- **`types.ts`** is the shared contract — all interfaces (`FileDoc`, `ChunkDoc`, `VersionDoc`, `SyncRecord`) and constants live here. Import types from here, not from other modules.
- **`util.ts`** contains only pure functions with zero Obsidian API dependencies — these are the primary unit test targets.
- **`crypto.ts`** uses only WebCrypto (no Obsidian API) — also fully testable.
- **`indexpanel.ts`** is the single implementation of the sync status UI. It is mounted twice — by the settings tab and by the sidebar view — so never fork it: a change must land in one place, or the two views drift apart. Multiple instances may be mounted at once; each owns its host element and its own timers, and index reports are de-duplicated in `main.ts`.
- **`main.ts`**, **`settings.ts`**, **`indexpanel.ts`** and **`view.ts`** depend on the Obsidian API and are excluded from unit test coverage. Test them via the e2e suite.
- **`engine.ts`** orchestrates everything. It depends on Obsidian's `App`, `Vault`, and `TFile` APIs. Testing requires mocking the Obsidian API.

## Code Quality

### Linting

ESLint with `@typescript-eslint` in flat config format (`eslint.config.mjs`).

```bash
npm run lint
```

Rules:
- Unused variables are errors (with `^_` prefix exception for intentionally unused args)
- `no-explicit-any` is a warning (not error) — some PouchDB types require `any`
- `ban-ts-comment` is off — `@ts-ignore` is occasionally needed for PouchDB internals
- `no-require-imports` is off — `engine.ts` uses Node.js `require()` for desktop-only streaming

### TypeScript

Strict mode enabled (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`).

```bash
npx tsc --noEmit --skipLibCheck
```

Target: ES2018. Module: ESNext. The build output is a single `main.js` via esbuild.

### Testing

Vitest with v8 coverage. Tests live in `tests/`.

```bash
npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # with coverage report
```

Test files follow the pattern `tests/<module>.test.ts`. Focus unit tests on pure modules (`util.ts`, `crypto.ts`). Modules that depend on the Obsidian API (`main.ts`, `settings.ts`) are excluded from coverage.

End-to-end tests drive the built plugin inside a real Obsidian (`npm run test:e2e`, see `e2e/README.md`). `wdio.conf.mts` stages a clean plugin copy in `.e2e-plugin/` — never point the harness at the repo root, which would copy a developer's local `data.json` (real credentials and passphrase) into the sandbox vault.

### Build

```bash
npm run build   # tsc type-check + esbuild production bundle
npm run dev     # esbuild watch mode (no type-check)
```

Output: `main.js` (single bundled file, committed to releases only, gitignored in repo).

## Git Conventions

### Branch Naming

Feature branches follow the pattern:

```
feature/<short-descriptive-name>
```

Examples:
- `feature/remote-state-display`
- `feature/batch-conflict-resolution`
- `feature/mobile-sync-indicator`

Use lowercase, hyphen-separated names. Keep it short but descriptive enough to understand the scope at a glance.

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: five distinct states (drift vs conflict) with severity-based rollup
fix: index report must respect the hidden-files toggle for DB docs
chore: add CI pipeline, linting, unit tests, and release workflow
refactor: unify the whole index UI on one four-state classification
```

Prefixes: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `ci:`.

A `feat:` commit signals a new user-facing capability. A `fix:` commit corrects a bug. Use `chore:` for tooling, deps, and infrastructure that don't change runtime behavior.

### Pull Requests

- PR titles follow the same conventional commit format (`feat: ...`, `fix: ...`)
- One feature branch per PR
- Merge strategy: squash merge into `main`

## Versioning & Releases

### Semantic Versioning

Version format: `MAJOR.MINOR.PATCH` (e.g. `0.32.0`). Three files must stay in sync:

| File | Role |
|------|------|
| `package.json` | Source of truth for `npm version` |
| `manifest.json` | What Obsidian reads (version + minAppVersion) |
| `versions.json` | Compatibility map: plugin version -> minimum Obsidian version |

### Release Flow

1. Bump version locally:
   ```bash
   npm version patch   # 0.32.0 -> 0.32.1
   npm version minor   # 0.32.0 -> 0.33.0
   npm version major   # 0.32.0 -> 1.0.0
   ```
   This triggers `version-bump.mjs` (via npm's `version` lifecycle script), which syncs the version into `manifest.json` and adds the entry to `versions.json`. Both files are auto-staged.

2. Push the tag (**no `v` prefix** — Obsidian requires bare version tags):
   ```bash
   git push origin main --tags
   ```

3. GitHub Actions (`release.yml`) triggers on the tag, builds the plugin, and creates a GitHub Release with `main.js`, `manifest.json`, and `styles.css` attached.

### CI Pipeline

GitHub Actions (`ci.yml`) runs on every push and PR:
- Lint (ESLint)
- Type check (tsc)
- Unit tests (Vitest)
- Production build (esbuild)

Matrix: Node.js 20 + 22.

## Common Commands

```bash
npm ci                # install dependencies (clean)
npm run lint          # eslint
npm run build         # type-check + production bundle
npm test              # run tests
npm run test:coverage # tests with coverage
npm run dev           # esbuild watch mode
```
