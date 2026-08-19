# Roadmap

Everything that is known to be open, in one place, so the next release can take it
on as a single batch instead of one fix per version.

This file replaces `BUGREPORT.md` (a bug review of the metadata-E2EE merge) and
`CODE_REVIEW.md` (a full review at 0.32.0). Both were audited against the code at
**0.40.0** and were largely worked off — carrying two documents that read as acute
findings while describing a fixed codebase is worse than carrying none. Everything
still open from them is restated below with a current file reference; the originals
remain in the git history.

Nothing here is implemented yet. This document is the plan.

**Status legend:** 🔴 do first · 🟠 should ship in the same release · 🟡 nice to have
· 🔵 new feature · ⚪ accepted, no action

---

## 1. Open bug fixes

### R1 🔴 — `.git/` is only excluded by convention, not by rule

**Where:** `src/engine.ts` — `isSkipped()`

**What:** `isSkipped()` hard-protects exactly two things: the streaming temp suffix
and the plugin's own `data.json`. Everything else, `.git/` included, depends on the
user-editable `hiddenExclude` list. The list is seeded from `DEFAULT_HIDDEN_EXCLUDE`
(`src/types.ts`) and re-unioned once by migration v1 (`src/migrate.ts`), so the
default case is safe — but a user who removes the entry, or a config the migration
never touched, syncs a whole git repository again.

**Why it matters:** replicating `.git/` is repo-destroying, not just noisy. Objects,
packs and refs replicate independently and with delay; a half-synced `.git/` on a
second device is a corrupt repository. This was the original 0.32.0 symptom (1309
files "local only") and the one recommendation from that review that was never
implemented.

**Fix:** move `.git/` (and the vault's own `.obsidian/plugins/couchdb-sync/`) into
the unconditional branch of `isSkipped()`, above the `syncHidden` check, so no
configuration can opt back in. Keep the entries in `DEFAULT_HIDDEN_EXCLUDE` as well
so the settings UI still shows them; the hard rule is the backstop, not the display.

**Acceptance:** a unit test that sets `hiddenExclude: []` and `syncHidden: true` and
asserts `.git/objects/ab/cdef` is still skipped. Extend `tests/hidden-scan.test.ts`.

---

### R2 🟠 — Two devices with different passphrases diverge with no clear message

**Where:** `src/engine.ts` (push path), `src/database.ts` — `getDecryptStats()`

**What:** the passphrase is only checked for emptiness. Two devices with *different*
non-empty passphrases write into disjoint id spaces (paths are HMAC'd under the
passphrase) and cannot read each other's documents. `getDecryptStats()` +
`passphraseError` catch the case where this device can read *nothing* — but only
after a scan, only locally, and not the mixed case where a shared database ends up
holding two id spaces at once.

**Why it matters:** the failure looks like "the other device isn't syncing" rather
than "your passphrases differ". Both sides keep writing, and the database silently
accumulates two parallel vaults.

**Fix:** a sentinel document written on first successful sync — a known plaintext
encrypted under the passphrase, at a fixed id. On start, try to decrypt it: absent →
write it; present and decryptable → proceed; present and undecryptable → stop before
replicating and say plainly that this device's passphrase does not match the one the
database was created with, offering the same Wipe / re-enter recovery the origin
fingerprint mismatch already offers (`doRestart` in `src/main.ts` is the precedent).

**Acceptance:** unit test over the three outcomes (absent / match / mismatch), plus
the guard refusing to start on mismatch. Carried over from `BUGREPORT.md` B13, the
only item from that document still fully open.

---

### R3 🟠 — Large binaries can exhaust memory on mobile

**Where:** `src/engine.ts` — the `desktopFs` gate and `writeAssembled()`

**What:** the streaming download path requires `Platform.isDesktop && adapter
instanceof FileSystemAdapter`. On mobile every file goes through `writeAssembled()`,
which collects all chunks into an array and concatenates them, so peak memory is
roughly twice the file size.

**Why it matters:** the manifest says `isDesktopOnly: false`. A 100 MB video in the
vault is an out-of-memory crash on a phone, not a slow download.

**Fix (in ascending order of effort):**
1. A size ceiling above which mobile refuses to materialize a file, reports it in the
   panel as "too large for this device" and leaves the document alone. Honest and
   small — no half-written files, no crash.
2. Chunk-wise append via `adapter.append()` where the platform supports it, so peak
   memory stays at one chunk.

Ship 1 in this batch; 2 is its own piece of work.

**Acceptance:** a mobile-path test asserting that a file above the ceiling is
classified and reported rather than assembled.

---

### R4 🟡 — Deleted files stay in the database forever

**Where:** `src/engine.ts` — `handleLocalDelete()` writes `deleted: true` with
`_deleted: false`

**What:** deletions are logical: the file document survives as a tombstone so the
deletion can replicate. Nothing ever removes them. `auto_compaction: true` on the
local database compacts *revisions*, not documents.

**Why it matters:** the database grows monotonically with delete activity, and every
tombstone is replicated to every device forever.

**Fix:** an age-based sweep — a tombstone older than a threshold (a few months) whose
path has no live document may be hard-deleted. Must run on one device only (the
master, when a master is configured) or be idempotent enough that concurrent sweeps
converge. Needs care: a device that was offline longer than the threshold would
resurrect the file. Treat the threshold as a documented trade-off, not a tunable.

**Acceptance:** design note first, then implementation. This is the one item that may
sensibly slip to the release after.

---

### R5 🟡 — `putLocalDoc` does not always write a local document

**Where:** `src/database.ts` — `putLocalDoc()`, called with `MASTER_INFO_ID`

**What:** the method only writes a true non-replicating `_local/` document when the
id starts with `_local/`. `MASTER_INFO_ID = "couchdb-sync:masterinfo"` does not, so
that document replicates — deliberately, but the method name says otherwise.

**Why it matters:** cosmetic today. The concrete risk this created — a cleartext
device id reaching the server — is fixed (the body is encrypted when E2EE is on),
but the name is a trap for the next person adding a call.

**Fix:** rename to `putDoc` / `putRawDoc`, or split into `putLocalDoc` (asserts the
`_local/` prefix) and `putSharedDoc`. Pure refactor, no behaviour change.

---

## 2. Test gaps

The 0.32.0 review named four areas that most needed coverage. Two now have it
(conflict resolution in `tests/conflict.test.ts`, skip rules in
`tests/hidden-scan.test.ts`). Two do not — and both guard data-loss paths.

### R6 🟠 — No test for the heal loop

**Where:** `src/engine.ts` — `healAttempts`, `HEAL_MAX_ATTEMPTS`, the `stuck` set

**What to cover:** a pull whose chunks are missing triggers a re-upload; after
`HEAL_MAX_ATTEMPTS` the path lands in `stuck`, is reported once, and is no longer
retried on every pull; a local edit or a manual resolve clears `stuck` and gives the
path a fresh attempt. The existing "heal" matches in `tests/reconcile.test.ts` and
`tests/database.test.ts` are about the reconcile sweep and handle reopening — they do
not touch this loop.

### R7 🟠 — No test for the echo guard

**Where:** `src/engine.ts` — `suppress`, `handleLocalUpsert()`, `isUnchanged()`

**What to cover:** the guard's correctness rests on a subtlety — the suppress token is
consumed *without* an early return, so a user edit inside the 400 ms debounce window
still pushes because its mtime/size differ from what `recordSynced` stored. That is
the property to pin down: a remote write followed by a concurrent local edit must
result in the local edit reaching the database, and a remote write alone must not
echo back as an upload.

---

## 3. New feature

### R8 🔵 — Cloudflare Tunnel support (optional)

Put a Cloudflare Tunnel in front of CouchDB so the server needs no open port, no
public IP and no manually managed certificate. **Not implemented — specified here so
it can be built as one piece.**

Two levels, and they need very different amounts of work:

**Level 1 — plain tunnel, public hostname.** Already works today with no code change:
`cloudflared` publishes the CouchDB as `https://couch.example.com`, and the user types
that URL into the existing server field. The tunnel is invisible to the plugin. This
is a **documentation** task — a "Cloudflare Tunnel" path in the README's *Getting a
server* section, alongside the existing options. Ship it with the feature.

**Level 2 — tunnel protected by Cloudflare Access.** This is the actual feature. With
a Zero Trust policy in front of the hostname, an unauthenticated request is answered
with a redirect to a login page, not with CouchDB. Machine clients authenticate with
a **service token**: two headers on every request, `CF-Access-Client-Id` and
`CF-Access-Client-Secret`.

**Design:**

- **Settings:** a toggle `cfAccessEnabled` (default off) plus `cfAccessClientId` and
  `cfAccessClientSecret`, shown in the connection section only when the toggle is on.
  Default off means existing configurations are untouched.
- **The client secret is a credential.** It must go into the sealed blob, never into
  `data.json` in the clear — the whole point of 0.40.0. That means extending
  `Secrets` in `src/secrets.ts` and everything that walks it (`sealSecrets`,
  `unsealSecrets`, `decideSealAction`, `toPersisted`) plus a schema migration (v7) so
  an existing sealed blob keeps unsealing. The client *id* is not secret and can stay
  in the persisted settings.
- **Header injection:** `obsidianFetch()` in `src/database.ts` builds the header map
  for every request PouchDB makes. It currently takes no arguments; give it the
  settings (or a header supplier) so both the replication handle from
  `connectRemote()` and the direct `scanRemote()` carry the headers. One place, both
  paths — anything less means replication authenticates and the panel does not, or
  the reverse.
- **Handle invalidation:** the remote handle bakes its fetch in at construction, so
  editing the token must call `closeRemote()` — exactly the trap the password fell
  into before 0.40.0. Wire it into the existing `invalidateConnection()`.
- **Error mapping:** an Access-protected endpoint without a valid token answers with
  an HTML login page or a redirect. Without special handling that surfaces as a JSON
  parse error or a bare transport failure. Map it to a named cause alongside the
  existing `auth` / `notfound` / `network` in `RemoteScan`, so *Test connection* can
  say "Cloudflare Access rejected the service token" instead of something unreadable.

**Risks to verify against a real tunnel before shipping:**

- **Idle timeout vs. the live feed.** Continuous replication holds a long-poll
  `_changes` request open. Cloudflare's proxy has its own idle timeout (100 s on the
  free plan), which can close a feed the plugin believes is healthy. The existing
  `LIVE_SYNC_RESTART_LIMIT` and the mobile resume recovery may already absorb this,
  or a shorter heartbeat may be needed so the feed keeps itself alive. Must be
  measured, not assumed.
- **Request body limits.** Cloudflare caps request bodies (100 MB on the free plan).
  `CHUNK_SIZE` is 1 MiB so a single chunk is safe, but a large `_bulk_docs` batch is
  worth checking against the cap.
- **Service token expiry.** Service tokens expire. A clear, non-cryptic message when
  a previously working setup starts returning 403 is part of the feature, not a
  follow-up.

**Acceptance:**

- Unit tests: headers present when the toggle is on and absent when off; the sealing
  round-trip with the new field; migration v7 over a v6 blob.
- A manual verification against a real tunnel, with the idle-timeout behaviour of the
  live feed observed over at least a few minutes and written down.
- README: both levels documented — the plain tunnel as a server option, Access as the
  toggle.

---

## 4. Accepted, no action

Carried over so nobody re-opens them without new information.

| Item | Why it stays |
|---|---|
| **History id leaks an 8-char hash prefix** | The tail is a hash of the child-id list, not a chunk id, so it reveals version-content equality and timestamp correlation — both already disclosed in the README as residuals. Changing the id format breaks stored data. |
| **Change detection compares mtime + size only** | A content hash on every stat call would defeat the fast path. The failure mode — an in-place edit that preserves both size and mtime — is rare, and the reconcile sweep catches the common variants. |
| **Migration re-unions the hidden-exclude defaults** | It runs once (gated on `priorVersion < 1`) and protects the majority from syncing `.git/`. R1 makes this moot for the dangerous entry by enforcing it in code instead. |
| **Chunk dedup reveals repetition structure** | Identical plaintext chunks share an id, so the server sees which pieces repeat. Inherent to content-addressed dedup, and disclosed in the README. |
| **Initial index is serial** | One file per event-loop tick keeps the UI responsive. The two things that made it pathological — walking `.git/`, and re-serializing the whole state map per file — are both fixed (hidden-walk pruning and 64-way state sharding). |

---

## 5. Suggested grouping for the next release

| Release | Contents |
|---|---|
| **Next** | R1, R2, R3 (option 1), R6, R7, R8 |
| **The one after** | R4, R5, R3 (option 2 — chunk-wise append) |

R1 and R2 are the two that can still cost a user data. R6 and R7 belong in the same
release because they cover the paths R1–R3 touch. R8 is additive and independently
testable, so it can land in parallel without blocking the fixes.
