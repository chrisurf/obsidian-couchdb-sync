# Implementation plan

The [roadmap](ROADMAP.md) says *what* is open. This says *in which order to build it*,
sorted by effort — cheapest first — so the list can be worked from the top without
planning each item again.

Every claim below was checked against the code at **0.40.0**, not taken from the
roadmap text. Sizes are relative (XS/S/M/L) with a rough range; treat them as
sequencing information, not as commitments.

**One caveat before the order:** everything from Batch 1 down is sorted by *effort*,
cheapest first. Batch 0 is the exception and is placed by *decision* — these three lead
regardless of what they cost, and are not traded against cheaper items that happen to
fit in an afternoon. **R13 is next up**: it is the only open item with no workaround at
all. R9 follows because it is the destructive action. R14 third because it is currently
telling users the opposite of the truth. Each gets its own PR.

---

## Batch 0 — first, each on its own PR

### 1. R13 — one exclude list that applies to every file · M (~4–6 h)

**Files:** `src/engine.ts` (`isSkipped`), `src/types.ts` (the default lists),
`src/settings.ts` (both list fields), `src/migrate.ts` (v7),
`tests/hidden-scan.test.ts`, `tests/migrate.test.ts`.

Today the exclude/include lists are only consulted inside the `isHidden(path)` branch
of `isSkipped()`. A normal file falls straight through to `return false` — always
synced. So `node_modules/`, which is already in the defaults, does nothing for
`Projects/app/node_modules/`; it only ever matches a `node_modules` under a hidden
folder. A vault with one Node project in it syncs tens of thousands of files and the
user has no setting to stop it.

Build it in this order:

1. **Move the exclude check above `isHidden()`** in `isSkipped()`, so it applies to
   every path. `matchesIgnore` needs no change — `node_modules/` already matches at any
   depth via `path.includes("/" + p)`. This is the whole fix for the reported problem;
   everything below is making it comprehensible.
2. **Keep the include list as the override**, ahead of the exclude check. It is the
   only way to say "from this excluded area I want exactly one thing" —
   `.obsidian/snippets/` in one line, versus enumerating every other plugin folder in a
   list that is never finished. Rule: **exclude wins unless explicitly re-included.**
3. **Both fields visible at once**, with new labels. They currently swap on
   `syncHidden` and are phrased as continuations of the toggle (*"…except these"*,
   *"…but still sync these"*), which stops being true once the exclude list always
   applies. *"Do not sync these"* and *"Sync these anyway"*, each saying plainly what
   it does and which one wins.
4. **Migration v7.** Existing entries keep working and now reach further. Nothing is
   deleted — a newly excluded file stops being pushed, stays on every disk, and shows
   in the tree as *excluded*; removing the line brings it back.

**Watch out for:** the hidden behaviour must come out unchanged. With
`syncHidden: false` and an empty include list, nothing hidden may sync — that is the
existing contract and `tests/hidden-scan.test.ts` already pins the walk-level half of
it.

**Done when:** `isSkipped` is tested for a **normal** path (`node_modules/x.js`
excluded by default, `Notes/note.md` synced, an include re-enabling an excluded normal
path), the hidden cases still pass untouched, and a migration test covers a pre-v7
config.

**Risk:** medium. It changes which files are in scope for sync, which is the core
classification every other path depends on — hence its own PR. The failure mode is
"something the user wanted is no longer synced", visible in the tree as *excluded* and
undone by deleting a line; nothing is removed from disk or from the server.

---

### 2. R9 — show the delta before "Reset server" destroys it · M (~4–6 h)

**Files:** `src/main.ts` (`doServerReset`), `src/util.ts` (the comparison),
`src/history.ts` (`ConfirmModal`), `src/settings.ts` (the confirmation copy), new
`tests/reset-preflight.test.ts`.

"Reset server" empties the remote database and re-uploads this device's files. Its
dialog describes what the action does in general, and says nothing about what it will
do *here* — so the harmless case (both sides already match, nothing is lost) and the
expensive one (another device pushed files this device never had) are presented
identically, and the user confirms blind.

The work splits cleanly in three, which is also the order to build it:

1. **The comparison, pure.** `(serverPaths, diskPaths) → { equal, serverOnly,
   localOnly, serverCount, diskCount }` in `src/util.ts`. Testable with no Obsidian
   and no database, and it is where the one subtle decision lives: compare against
   **disk**, not against the local cache. The re-upload afterwards walks
   `app.vault.getFiles()`, so disk is what survives; `IndexReport.serverOnly` is
   computed against the cache and would answer a different question.
2. **The pre-flight, in `doServerReset`.** After the existing credential and
   passphrase checks, before `resetRemote()`. Take a *fresh* scan — `main.ts` throttles
   `scanRemote()` to 15 s, which is correct for the panel and wrong for the one moment
   the reading has to be right. No difference → today's dialog, one click, unchanged.
3. **The delta dialog.** Counts side by side with a proportional bar, the server-only
   paths listed by name (truncated with "…and N more"), local-only kept visually
   separate because those are uploaded rather than lost, and **Delete anyway** /
   **Cancel**. `ConfirmModal` currently takes a plain string `body`, so give it a
   render hook rather than writing a second modal — two destructive dialogs that look
   different is a worse outcome than either of them alone.

**Watch out for:** an unreachable server. The scan can fail, and "I could not check"
must not fall through to the silent path — an unknown delta is not an empty one. Route
it to the delta dialog with its own wording.

**Done when:** the pure comparison is tested over all four shapes; cancelling the
delta dialog leaves the server untouched; and a two-device manual run (push a file
from B only, then Reset on A) names that file in the dialog.

**Risk:** medium, and concentrated in one place — this is a destructive path, so it
wants its own PR and the manual two-device run before merging. The failure mode of the
change itself is benign (an extra dialog where none was needed); the failure mode of
getting the *comparison* wrong is not, which is why it is pure and tested first.

---

### 3. R14 — say what the server actually answered · S (~2–3 h)

**Files:** `src/database.ts` (`testConnection`, `scanRemote`), `src/indexpanel.ts`
(the server error wording), `src/engine.ts` (live-feed revival), `tests/database.test.ts`.

Reproduced against a real server: CouchDB replies **403**
`{"error":"forbidden","reason":"You are not allowed to access this db."}` — login fine,
account not a member of the database. The plugin then says three wrong things: the
connection test reports **success** (the JSON error body is read as database info
without a status check, which is where the `(undefined docs)` comes from, and it sets
`connectionVerified`), the panel reports **"server unreachable (network/transport)"**
(403 is missing from the `401 → auth / 404 → notfound / else → network` mapping), and
the retry loop never stands down (live feed plus the 15 s scan, several hundred
identical console errors).

- Check the status before treating a body as info; add the `403` branch to
  `testConnection()` naming the actual cause, and report the real status code in the
  catch-all.
- Add `forbidden` to `RemoteScan.error` and give it wording that separates "answered,
  but refused" from "did not answer".
- Stop reviving the feed on a repeated 401/403 until something changes — settings
  edited, credentials unlocked, manual Force sync. `hasCredentials()` is the precedent.

**Done when:** the status mapping is tested end to end (401/403/404/network), and a
403 body makes `testConnection()` return `ok: false` — the regression that otherwise
passes silently.

**Risk:** low, and confined to error paths. Do it near R8 Level 2, which extends the
same error vocabulary for Cloudflare Access.

---

## Batch 1 — one sitting, one PR

Five items, none of which touches sync behaviour. They are independent, so a single
PR is honest here rather than five.

**Items 4 and 5 are done**; items 6–8 are still open. Both finished ones are marked ✅
below with what actually shipped, since it differed from the plan in one place.

### 4. ✅ R8 Level 1 — document the Cloudflare Tunnel · XS (~30 min)

**Files:** `README.md` only. No code.

The plain tunnel already works: `cloudflared` publishes CouchDB as
`https://couch.example.com` and the user types that into the existing server field.
Nothing in the plugin knows or cares.

- Add a *Cloudflare Tunnel* entry to the README's **Getting a server** section,
  alongside the existing options.
- State plainly what it does and does not give you: no open port, no public IP, no
  manual certificate — but also no access control. Access control is Level 2 (item 13).

**Done when:** a reader can set up a tunnel from the README without leaving it.
**Risk:** none. Nothing to break.

---

### 5. ✅ R5 — rename `putLocalDoc` · XS (~20 min)

**Files:** `src/database.ts:782`, plus 6 call sites (`src/engine.ts` ×4,
`src/main.ts:768`).

The method writes a genuinely non-replicating `_local/` document only when the id
starts with `_local/`. Two of the six calls pass `MASTER_INFO_ID`
(`"couchdb-sync:masterinfo"`), which does not — so that document replicates. That is
deliberate and the doc comment says so, but the *name* says the opposite.

Split it, so the type system enforces the distinction instead of a comment:

- `putLocalDoc(id, value)` — asserts the `_local/` prefix, throws otherwise.
- `putSharedDoc(id, value)` — the replicating variant, used by the master-info calls.

**Done when:** `tsc` passes with every call site pointing at the right one.

**What shipped instead:** the prefix checks **throw at runtime** rather than relying on
the compiler alone, and `getLocalDoc` asserts the same prefix so reads cannot drift
either. That makes it no longer the pure refactor described above — so it is tested:
four cases covering a wrong id on each method and a `putSharedDoc` round-trip. Without
the guards this would have been a rename that the same mistake walks past in six
months.

**Why here and not later:** the next two items that touch this file, R2 (sentinel
document) and R4 (tombstone sweep), both add callers. Renaming after they land means
renaming more code and reviewing the trap twice.

**Risk:** none beyond a mechanical rename; no runtime behaviour changes.

---

### 6. R10 — stop the derived-key cache from growing forever · XS (~30 min)

**Files:** `src/crypto.ts` (`deriveKey`, `keyCache`), `src/main.ts` (`teardown`),
`tests/crypto.test.ts`.

`deriveKey` caches under `base64(salt) + "|" + passphrase` and never evicts. Every
`encryptString` / `encryptBytes` call draws a *fresh random salt*, so every chunk
written inserts an entry that can never be looked up again — a 600 MB upload leaves
~600 dead `CryptoKey`s, a full vault upload thousands. `clearKeyCache()` was written
for this and is never called; `teardown()` clears only the credential cache.

- Skip the cache write on the encrypt path (the entry is provably unreachable).
- Keep it on the decrypt path, where a repeated salt is real — a chunk shared across
  files, or a re-read after the hydrated cache was rebuilt.
- Cap what remains with a small LRU, and call `clearKeyCache()` in `teardown()`
  alongside `clearSecretKeyCache()`.

**Done when:** a test asserts N encryptions leave the cache size unchanged and that
decrypting the same payload twice derives once.

**Risk:** none — the net effect on the sync path is less work. Worth stating plainly
in the commit that this is a memory fix, not a confidentiality one: the cache only
ever held keys the running session was already entitled to, and someone skimming the
diff will otherwise assume the opposite.

---

### 7. R11 — warn on an `http://` server URL · S (~1 h)

**Files:** `src/util.ts` (the predicate), `src/settings.ts` (the connection section
and the Test result), `tests/util.test.ts`.

Nothing checks the scheme. The field's own description says https is required; the
code accepts `http://` and syncs, sending the CouchDB password in the clear in the
`Authorization` header on every request. Nothing surfaces, so nothing gets noticed.

A **warning, not a block** — and never for loopback, because `http://127.0.0.1:5984`
is the Docker quickstart the README hands people in Step 1 and it has to keep working.
Someone on a trusted LAN or behind a TLS-terminating tunnel may also mean it.

**Watch out for:** doing this as a regex. Put it through `URL` and check the parsed
host, or `https://evil.example.com/?x=http://` and similar shapes will decide it for
you. An unparseable URL warns.

**Done when:** the predicate is tested over https / http+loopback / http+remote /
unparseable, and the warning appears inline in the connection section rather than only
in the Test result — the point is to catch it while it is being typed.

**Risk:** none. Advisory only; nothing changes about what connects.

---

### 8. R12 — per-folder file count in the status tree · S (~1–2 h)

**Files:** `src/indexpanel.ts` (`renderTree`), `styles.css`, `tests/tree-count.test.ts`.

A badge on each folder row showing how many files sit in its whole subtree,
right-aligned just left of the `⋯` button. The row is already a flex line with the
name at `flex: 1`, so inserting the span between the name and `iconBtn(...)` puts it
exactly there; the pill styling already exists as `.couchdb-sync-section-count`.
`renderTree` is shared, so all three store trees get it at once.

Two things decide whether this looks finished or sloppy:

- **File rows need an equal-width empty slot.** They are flex too, so their `⋯` is
  flush right today. A badge on folder rows only pushes the folder's button left and
  the `⋯` column stops lining up.
- **Fold the count into the existing state walk.** `folderState()` already walks each
  folder's whole subtree, once per folder — a file at depth *d* is visited *d* times.
  Do not add a second walk. One post-order pass annotating each node with
  `{ worst, count }` visits every file once, so this ships as a net speed-up rather
  than a cost.

**Done when:** the annotation pass is pure and tested without a DOM (nested sums, an
empty folder at 0, root equal to the section total), and the `⋯` column is straight in
a mixed folder/file tree.

**Risk:** none. Display only; nothing it computes feeds a sync decision.

---

## Batch 2 — the two test gaps

No production code changes. Both cover paths batch 1 and batch 3 touch, which is the
argument for doing them before, not after. The harness exists already: `reconcile`,
`force-sync` and `remote-delete-propagation` all construct an engine against the
in-memory adapter.

### 9. R7 — echo guard · S (~2–3 h)

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

### 10. R6 — heal loop · M (~3–5 h)

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

### 11. R3 option 1 — refuse oversized files on mobile · M (~4–6 h)

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

### 12. R2 — sentinel document for passphrase mismatch · M–L (~1–2 days)

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

### 13. R8 Level 2 — Cloudflare Access · M–L (~2–3 days incl. verification)

**Files:** `src/types.ts`, `src/database.ts` (`obsidianFetch`, `connectRemote`,
`scanRemote`, `RemoteScan`), `src/settings.ts`, `src/main.ts`
(`invalidateConnection`), README. **Not** `src/secrets.ts`.

**This got smaller than first estimated.** The original plan put the client secret
into the sealed blob, which meant extending `Secrets`, threading it through
`sealSecrets` / `unsealSecrets` / `decideSealAction` / `toPersisted`, and a schema
migration v7 so existing blobs keep unsealing — work on the one path that already
holds the user's password.

None of that is needed. Both values go into `app.saveLocalStorage()`, which is
vault-scoped and never written by `saveData()`, so they do not reach `data.json` in
any form. That is not a weaker choice: the sealed blob's ceiling is "localStorage is
safe" anyway, because the device key that opens it lives there. Same strength against
local disk access, better against anything that carries the vault onward, and a
migration less.

Two things to note in code: two credentials now use two mechanisms (justified — an
Access token should be per device, the CouchDB password is the same everywhere), and
localStorage is plaintext and is lost when app data is cleared, so the token must be
re-enterable.

`obsidianFetch()` builds the header map for every request PouchDB makes and currently
takes no arguments. Give it the settings or a header supplier, so the replication
handle from `connectRemote()` **and** the direct `scanRemote()` both carry the headers.
Anything less and replication authenticates while the panel does not, or the reverse.

Two things 0.40.0 already put in place, which this should use rather than re-derive:

- `closeRemote()` exists — wire the token edit into `invalidateConnection()`, which
  already calls it. This is exactly the trap the password fell into before 0.40.0: the
  handle bakes its fetch in at construction.
- `RemoteScan.error` already has the `auth` / `notfound` / `network` vocabulary. Add
  the Access causes there. There are **three** to tell apart, not two: 401 with JSON
  (CouchDB rejected the login), 403 (Access rejected the token), and a 302 or HTML
  where JSON was expected (the Access policy is not set to *Service Auth*, so it
  answers with an identity-provider login page). The third is the one no user
  diagnoses unaided, and the one that reaches a JSON parser as a syntax error.

**Must be measured, not assumed** — against a real tunnel:

- **Idle timeout vs. the live feed — likely a non-issue.** Cloudflare closes
  connections idle for 100 s on free and pro. But PouchDB's HTTP adapter appends
  `heartbeat=10000` to every changes request by default, and CouchDB then sends a
  blank line every 10 s, so the connection is never idle that long. Confirm that is
  what is happening rather than watching blindly for a disconnect; if it does drop,
  the answer is a shorter heartbeat, not new machinery.
- **Which status code Access actually returns** for a missing or invalid token —
  Cloudflare does not document it. The three-case table above is the expected shape,
  not a verified one.
- **Request body limits.** 100 MB on the free plan. `CHUNK_SIZE` is 1 MiB so a single
  chunk is safe; check a large `_bulk_docs` batch against the cap.
- **Service token expiry.** Tokens expire. A clear message when a working setup starts
  returning 403 is part of the feature, not a follow-up.

**Independently testable and additive**, so it can run in parallel with batches 2–3
without blocking them.

---

### 14. R4 — tombstone sweep · L, design first

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
| 1 | R13 — general exclude list | M | **sync scope** | **next up**; no workaround exists |
| 2 | R9 — reset pre-flight delta | M | **destructive path** | by decision, not by effort |
| 3 | R14 — report 403 honestly | S | low | do near item 13 (same vocabulary) |
| 4 | ✅ R8-L1 — tunnel docs | XS | none | — |
| 5 | ✅ R5 — split `putLocalDoc` | XS | none | did before R2, R4 as planned |
| 6 | R10 — bound the key cache | XS | none | — |
| 7 | R11 — warn on `http://` | S | none | — |
| 8 | R12 — per-folder file count | S | none | — |
| 9 | R7 — echo guard test | S | none | — |
| 10 | R6 — heal loop test | M | none | — |
| 11 | R3-1 — mobile size ceiling | M | low | — |
| 12 | R2 — passphrase sentinel | M–L | **startup path** | — |
| 13 | R8-L2 — Cloudflare Access | M–L | medium | parallelisable |
| 14 | R4 — tombstone sweep | L | **distributed correctness** | design note first |

Items 1–3 lead, each on its own PR. Items 6–8 are a single afternoon and a single PR.
Items 9–10 are pure test work and can be picked up by anyone. Items 1, 2, 12 and 14 are
the four that deserve their own review and a manual run before merging.

**R1 is gone, not forgotten.** It asked for `.git/` to be enforced in code so no
setting could opt back in. Declined: the exclusion belongs in the configuration where
the user can see and change it, and it is already there and already pruned at the
walk level. See *Accepted, no action* in the roadmap.
