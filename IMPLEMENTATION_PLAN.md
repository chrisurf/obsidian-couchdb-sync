# Implementation plan

The [roadmap](ROADMAP.md) says *what* is open. This says *in which order to build it*,
sorted by effort — cheapest first — so the list can be worked from the top without
planning each item again.

Every claim below was checked against the code at **0.40.0**, not taken from the
roadmap text. Sizes are relative (XS/S/M/L) with a rough range; treat them as
sequencing information, not as commitments.

**One caveat before the order:** this is sorted by *effort*, as asked. Sorted by
*value* the list would open with R1 — it is the only remaining item that can still
destroy a user's git repository. It sits at position 3 because two things are even
cheaper, not because it is less important. If you would rather ship value first, pull
R1 to the front; it depends on nothing.

---

## Batch 1 — one sitting, one PR

Three items, none of which touches sync behaviour. They are independent, so a single
PR is honest here rather than three.

### 1. R8 Level 1 — document the Cloudflare Tunnel · XS (~30 min)

**Files:** `README.md` only. No code.

The plain tunnel already works: `cloudflared` publishes CouchDB as
`https://couch.example.com` and the user types that into the existing server field.
Nothing in the plugin knows or cares.

- Add a *Cloudflare Tunnel* entry to the README's **Getting a server** section,
  alongside the existing options.
- State plainly what it does and does not give you: no open port, no public IP, no
  manual certificate — but also no access control. Access control is Level 2 (item 8).

**Done when:** a reader can set up a tunnel from the README without leaving it.
**Risk:** none. Nothing to break.

---

### 2. R5 — rename `putLocalDoc` · XS (~20 min)

**Files:** `src/database.ts:782`, plus 6 call sites (`src/engine.ts` ×4,
`src/main.ts:768`).

The method writes a genuinely non-replicating `_local/` document only when the id
starts with `_local/`. Two of the six calls pass `MASTER_INFO_ID`
(`"couchdb-sync:masterinfo"`), which does not — so that document replicates. That is
deliberate and the doc comment says so, but the *name* says the opposite.

Split it, so the type system enforces the distinction instead of a comment:

- `putLocalDoc(id, value)` — asserts the `_local/` prefix, throws otherwise.
- `putSharedDoc(id, value)` — the replicating variant, used by the master-info calls.

**Done when:** `tsc` passes with every call site pointing at the right one. There is no
behaviour to test — the compiler is the proof, and the split makes the wrong call
impossible rather than merely discouraged.

**Why here and not later:** the next two items that touch this file, R2 (sentinel
document) and R4 (tombstone sweep), both add callers. Renaming after they land means
renaming more code and reviewing the trap twice.

**Risk:** none beyond a mechanical rename; no runtime behaviour changes.

---

### 3. R1 — make `.git/` unskippable · S (~1–2 h)

**Files:** `src/engine.ts:104` (`isSkipped`), `tests/hidden-scan.test.ts`.

Today `isSkipped()` hard-protects exactly two things — the streaming temp suffix and
the plugin's own `data.json`. Everything else, `.git/` included, rests on the
user-editable `hiddenExclude` list. Empty that list and the plugin replicates a git
repository.

That is not noise, it is destruction: objects, packs and refs replicate independently
and with delay, so a half-synced `.git/` on a second device is a corrupt repository.

**Change:** add to the unconditional branch, above the `isHidden()` check:

- any path at or under `.git/`
- the plugin's own folder `<configDir>/plugins/couchdb-sync/` — today only its
  `data.json` is protected, so a sibling file (a lock file, a future cache) is fair
  game

Keep both in `DEFAULT_HIDDEN_EXCLUDE` so the settings UI still lists them. The hard
rule is the backstop; the list stays the display.

**Watch out for:** `shouldWalkHiddenDir()` in `src/util.ts` prunes the hidden-file
walk separately. Skipping a path at classification time does not stop the walker
descending into it, so a vault with a large `.git/` still pays for the walk. Prune
there too, or the fix is correct but slow.

**Done when:** a test sets `hiddenExclude: []` **and** `syncHidden: true` — the
maximally permissive configuration — and asserts `.git/objects/ab/cdef` is still
skipped. Add a second for the plugin folder.

**Risk:** low. The change only *adds* skips, so the failure mode is "a file the user
wanted is not synced", not data loss — and both paths are ones nobody should be
syncing.

---

## Batch 2 — the two test gaps

No production code changes. Both cover paths batch 1 and batch 3 touch, which is the
argument for doing them before, not after. The harness exists already: `reconcile`,
`force-sync` and `remote-delete-propagation` all construct an engine against the
in-memory adapter.

### 4. R7 — echo guard · S (~2–3 h)

**Files:** `src/engine.ts` — `suppress`, `handleLocalUpsert()`, `isUnchanged()`. New
`tests/echo-guard.test.ts`.

The property worth pinning down is a subtlety, not the happy path: the suppress token
is consumed *without* an early return, so a user edit inside the 400 ms debounce
window still pushes, because its mtime/size differ from what `recordSynced` stored.

Two cases:

1. A remote write alone must **not** echo back as an upload.
2. A remote write followed by a concurrent local edit **must** reach the database.

Case 2 is the one that would silently lose a user's keystrokes if the guard were ever
"simplified" into an early return. That is what the test is for.

---

### 5. R6 — heal loop · M (~3–5 h)

**Files:** `src/engine.ts` — `healAttempts`, `HEAL_MAX_ATTEMPTS` (= 3), `stuck`. New
`tests/heal-loop.test.ts`.

Cover the full life cycle:

- a pull whose chunks are missing triggers a re-upload
- after `HEAL_MAX_ATTEMPTS` the path lands in `stuck`, is reported **once**, and stops
  being retried on every pull
- a local edit or a manual resolve clears `stuck` and grants a fresh attempt

More setup than R7 — the test has to manufacture a document whose chunks are absent —
which is the whole difference in size between the two.

The existing "heal" matches in `reconcile.test.ts` and `database.test.ts` are about
the reconcile sweep and handle reopening. They do not touch this loop.

---

## Batch 3 — the two behavioural fixes

### 6. R3 option 1 — refuse oversized files on mobile · M (~4–6 h)

**Files:** `src/engine.ts:1488` (the `desktopFs` gate), `writeAssembled()` at 1924;
reporting in `src/indexpanel.ts`.

Streaming needs `Platform.isDesktop && adapter instanceof FileSystemAdapter`. On
mobile every file goes through `writeAssembled()`, which collects all chunks into an
array and concatenates: peak memory is roughly twice the file size. The manifest says
`isDesktopOnly: false`, so a 100 MB video is an out-of-memory crash on a phone.

Ship the honest, small version: a size ceiling above which mobile refuses to
materialize, reports the file in the panel as "too large for this device" and leaves
the document alone. No half-written files, no crash.

The chunk-wise `adapter.append()` variant (option 2) is a separate piece of work and
belongs in a later release.

**Design decision to make first:** the ceiling is a number the user will hit and have
to understand. Pick it from the actual mobile budget and state it in the message, not
just in code.

**Done when:** a mobile-path test asserts a file above the ceiling is classified and
reported rather than assembled.

---

### 7. R2 — sentinel document for passphrase mismatch · M–L (~1–2 days)

**Files:** `src/engine.ts` (start path), `src/database.ts`, `src/main.ts` (`doRestart`
is the precedent), settings/panel messaging.

Two devices with *different* non-empty passphrases write into disjoint id spaces —
paths are HMAC'd under the passphrase — and cannot read each other's documents. The
existing `getDecryptStats()` / `passphraseError` catches only "this device can read
*nothing*", and only after a scan. The mixed case, one database holding two id spaces,
goes unnoticed while both sides keep writing.

**Mechanism:** a sentinel document at a fixed id, holding a known plaintext encrypted
under the passphrase. On start:

| Sentinel | Meaning | Action |
|---|---|---|
| absent | fresh database | write it, proceed |
| decryptable | passphrase matches | proceed |
| present, undecryptable | **mismatch** | stop before replicating |

The stop is the point. The origin-fingerprint mismatch in `doRestart` already does
exactly this and offers Wipe / re-enter recovery — follow that shape rather than
inventing a second vocabulary for the same class of problem.

**Sequencing:** do this after R5, whose split it depends on for a correctly named
call.

**Done when:** unit tests over all three outcomes, plus the guard refusing to start on
mismatch.

**Risk:** touches the startup path, which every session goes through. This is the item
that most wants its own PR and a manual two-device run before merging.

---

## Batch 4 — the big ones

### 8. R8 Level 2 — Cloudflare Access · L (~1 week incl. verification)

**Files:** `src/secrets.ts` (+ migration v7), `src/types.ts`, `src/database.ts`
(`obsidianFetch`, `connectRemote`, `scanRemote`, `RemoteScan`), `src/settings.ts`,
`src/main.ts` (`invalidateConnection`), README.

The client secret is a credential, so it belongs in the sealed blob — that is the
whole point of 0.40.0. That means extending `Secrets` and everything that walks it
(`sealSecrets`, `unsealSecrets`, `decideSealAction`, `toPersisted`) plus a v7 migration
so existing sealed blobs keep unsealing. The client *id* is not secret and stays in
the persisted settings.

`obsidianFetch()` builds the header map for every request PouchDB makes and currently
takes no arguments. Give it the settings or a header supplier, so the replication
handle from `connectRemote()` **and** the direct `scanRemote()` both carry the headers.
Anything less and replication authenticates while the panel does not, or the reverse.

Two things 0.40.0 already put in place, which this should use rather than re-derive:

- `closeRemote()` exists — wire the token edit into `invalidateConnection()`, which
  already calls it. This is exactly the trap the password fell into before 0.40.0: the
  handle bakes its fetch in at construction.
- `RemoteScan.error` already has the `auth` / `notfound` / `network` vocabulary. Add
  the Access rejection as a named cause there, so *Test connection* can say
  "Cloudflare Access rejected the service token" instead of a JSON parse error from an
  HTML login page.

**Must be measured, not assumed** — against a real tunnel:

- **Idle timeout vs. the live feed.** Continuous replication holds a long-poll
  `_changes` open; Cloudflare's proxy times out at 100 s on the free plan. The existing
  `LIVE_SYNC_RESTART_LIMIT` and mobile resume recovery may absorb this — or a heartbeat
  may be needed. Observe it over several minutes and write down what happened.
- **Request body limits.** 100 MB on the free plan. `CHUNK_SIZE` is 1 MiB so a single
  chunk is safe; check a large `_bulk_docs` batch against the cap.
- **Service token expiry.** Tokens expire. A clear message when a working setup starts
  returning 403 is part of the feature, not a follow-up.

**Independently testable and additive**, so it can run in parallel with batches 2–3
without blocking them.

---

### 9. R4 — tombstone sweep · L, design first

**Files:** `src/engine.ts` — `handleLocalDelete()` writes `deleted: true` with
`_deleted: false`.

Deletions are logical so they can replicate; nothing ever removes the tombstones, and
`auto_compaction: true` compacts *revisions*, not documents. The database grows
monotonically with delete activity and every tombstone reaches every device forever.

This is last for a reason, and not only because of size: **a device offline longer than
the threshold resurrects deleted files.** That is a correctness problem in a
distributed system, not a tuning parameter, and it needs a written design before any
code:

- what the threshold is, and why that number
- who sweeps — one device only (the master, where configured), or an idempotent sweep
  that converges under concurrency
- what happens to a device that returns after a long absence

Write the design note, get it reviewed, then implement. The roadmap already allows
this one to slip a release; that is the right call.

---

## Summary

| # | Item | Size | Risk | Blocks / blocked by |
|---|---|---|---|---|
| 1 | R8-L1 — tunnel docs | XS | none | — |
| 2 | R5 — rename `putLocalDoc` | XS | none | do before R2, R4 |
| 3 | R1 — hard-skip `.git/` | S | low | — |
| 4 | R7 — echo guard test | S | none | — |
| 5 | R6 — heal loop test | M | none | — |
| 6 | R3-1 — mobile size ceiling | M | low | — |
| 7 | R2 — passphrase sentinel | M–L | **startup path** | after R5 |
| 8 | R8-L2 — Cloudflare Access | L | medium | parallelisable |
| 9 | R4 — tombstone sweep | L | **distributed correctness** | design note first |

Items 1–3 are a single afternoon and a single PR. Items 4–5 are pure test work and can
be picked up by anyone. Items 7 and 9 are the two that deserve their own PR, their own
review and a manual run before merging.
