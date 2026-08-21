# Roadmap

Everything that is known to be open, in one place, so the next release can take it
on as a single batch instead of one fix per version.

This file replaces `BUGREPORT.md` (a bug review of the metadata-E2EE merge) and
`CODE_REVIEW.md` (a full review at 0.32.0). Both were audited against the code at
**0.40.0** and were largely worked off — carrying two documents that read as acute
findings while describing a fixed codebase is worse than carrying none. Everything
still open from them is restated below with a current file reference; the originals
remain in the git history.

This document is the plan. Items marked ✅ have since been implemented; everything
else is still open.

**Status legend:** 🔴 do first · 🟠 should ship in the same release · 🟡 nice to have
· 🔵 new feature · ⚪ accepted, no action

---

## 1. Open fixes and safeguards

Listed in **priority order**. The R-numbers are stable identifiers so a reference in
a commit or an issue keeps pointing at the same thing — they are not the sequence to
work in.

### R13 🔴 — Normal files cannot be excluded from sync at all

**Where:** `src/engine.ts` — `isSkipped()`; `src/types.ts` — `DEFAULT_HIDDEN_EXCLUDE`
/ `defaultHiddenExclude()`; `src/settings.ts` (the two list fields); `src/migrate.ts`

**What:** `isSkipped()` only consults the exclude/include lists **inside** the
`isHidden(path)` branch, and `isHidden()` is true only when some path segment starts
with a dot. Everything else falls through to `return false` — always synced. The
settings text states it outright: *"Normal notes & attachments are always synced."*

The consequence is that `node_modules/`, which ships in `DEFAULT_HIDDEN_EXCLUDE`, does
**nothing** for `Projects/app/node_modules/`. It can only ever match a `node_modules`
nested inside a hidden folder, e.g. `<configDir>/plugins/x/node_modules/`. Same for
`tmp/`. The entries look like protection and are not.

**Why it matters:** a single Node project inside a vault is tens of thousands of
files, and there is no setting that stops them — the user cannot fix this from the
plugin at all. It is also the worst possible load for everything downstream: every one
of those files is hashed, chunked, encrypted, replicated, and walked again by the
index report on every refresh.

**Fix — two lists, both meaningful at all times:**

1. **"Do not sync these"** (today's `hiddenExclude`) — promoted to a **general**
   exclude, checked for *every* path, before the hidden branch. Ships with `.git/`,
   `node_modules/`, `.trash/`, `tmp/`, `.DS_Store` and the vault's configuration
   folder, and is always visible instead of appearing only when hidden sync is on.
2. **"Sync these anyway"** (today's `hiddenInclude`) — the narrow opt-in, which
   overrides list 1 *and* the hidden toggle. It stays, because a blacklist cannot
   express "from this excluded area I want exactly one thing". `.obsidian/snippets/`
   is one line here; saying the same thing with exclusions means enumerating every
   other plugin folder — a list that is never finished, because each newly installed
   plugin adds one more to forget.

The rule between them is **exclude wins, unless a path is explicitly re-included**,
and the UI has to say that as plainly as this line does. It is the `.gitignore` model
with a negation, which is the mental model most users already have.

`matchesIgnore()` itself needs no change: a pattern ending in `/` already matches at
any depth (`path.includes("/" + p)`), so `node_modules/` catches
`Projects/app/node_modules/x.js` as it stands. Only the place it is called from moves.

**Watch out for:**

- **Schema migration v7.** Existing configs get a list that suddenly reaches further —
  someone with `tmp/` stops syncing `Notes/tmp/` as well. That is the intent, but it
  has to be recorded rather than happening quietly. Nothing is deleted: a newly
  excluded file just stops being pushed, stays on every disk, and appears in the tree
  as *excluded*. Removing the line brings it straight back.
- **The two fields stop swapping, and both labels have to be rewritten.** Today they
  trade places depending on `syncHidden` (`visible: () => settings.syncHidden` in
  `src/settings.ts`), so the user never sees both and each one's meaning flips with the
  toggle. The exclude list must be **visible at all times**, because it will apply at
  all times. Its label and description are currently written as a continuation of the
  toggle above it — *"…except these"*, *"These **hidden** files/folders are NOT synced.
  Everything else hidden is."* — which stops being true and stops parsing on its own.
  It becomes *"Do not sync these"* / *"One path per line. These files and folders are
  never synced — on any device."* The include field gets the same treatment:
  *"…but still sync these"* does not say what it is an exception to.
- `shouldWalkHiddenDir()` prunes the *hidden* walk. The normal-file side has no walk to
  prune — `app.vault.getFiles()` already returns everything — so there it is a filter,
  not a prune. That is sufficient; Obsidian holds the list either way.

**Acceptance:**

- `isSkipped` tests for a **normal** path: `Projects/app/node_modules/x.js` excluded by
  default, `Notes/note.md` synced, and an explicit include re-enabling an excluded
  normal path.
- The hidden behaviour is provably unchanged: with `syncHidden: false`, nothing hidden
  syncs unless it is included.
- A migration test that a pre-v7 config keeps its own entries and gains the wider
  reach.

---

### R9 🔴 — "Reset server" deletes without saying what will be lost

**Where:** `src/main.ts` — `doServerReset()`; the confirmation in `src/settings.ts`
("Reset the server from this device"); `ConfirmModal` in `src/history.ts`

**What:** the action empties the remote database and re-uploads this device's files.
Its confirmation dialog explains the *consequences* in prose — "anything that exists
ONLY on the server is gone" — but never says whether that is true in this case, or
how much of it there is. The user confirms blind.

Everything needed to answer it already exists, and is already on screen elsewhere:
`scanRemote()` returns the server's decrypted, non-deleted paths, and
`buildIndexReport()` already publishes `serverPaths` and `diskPaths`. The check is a
comparison of two arrays the plugin recomputes every few seconds anyway.

**Why it matters:** this is the only action that destroys data no other action can
reach, and it is the one where the user is given the least information. The case that
costs data — a second device pushed files this device never had — is exactly the case
the current dialog cannot distinguish from the harmless one. Conversely, when both
sides already match, the reset destroys nothing and an extra warning would be pure
noise: a guard that fires every time gets clicked away every time, including the time
it mattered.

**Fix:** a pre-flight delta, taken after the existing credential/passphrase checks in
`doServerReset()` and before `resetRemote()`.

- Take a **fresh** remote scan rather than the cached one. `main.ts` throttles
  `scanRemote()` to `REMOTE_SCAN_TTL_MS` (15 s), which is right for a panel that
  repaints constantly and wrong here — this is the one moment where a stale reading
  has a cost.
- Compare the server against **this device's disk**, not against the local cache. The
  re-upload that follows walks `app.vault.getFiles()` (`indexLocalFiles`), so what
  survives the reset is what is on disk. `IndexReport.serverOnly` is computed against
  the cache and is therefore the wrong set here — use `serverPaths` minus `diskPaths`.
- **No difference → keep today's dialog, unchanged.** One click, exactly as now.
- **Difference → an extra dialog first**, ahead of the destructive confirmation:
  - the two counts side by side (server *N* files · this device *M* files) with a
    simple proportional bar, so the size of the gap is legible without reading
    numbers;
  - the paths that exist **only on the server**, listed by name and truncated with
    "…and N more" — that is the set the reset actually destroys;
  - kept visually apart from the paths that exist only on this device, which are *not*
    a loss (the re-upload puts them on the server). Both count as a difference and
    both are shown, but only one of them is damage;
  - buttons: **Delete anyway** (destructive) and **Cancel** (default focus).
- **Server unreachable → treat as a difference, never as agreement.** An unknown
  delta must not render as "nothing to lose": say the check could not run, and let
  the user cancel or proceed deliberately.

`ConfirmModal` takes a plain string `body`, so the delta dialog wants a render hook on
it rather than a second modal class — the two destructive dialogs should keep one look.

**Acceptance:**

- The comparison is a pure function over (server paths, disk paths) →
  `{ equal, serverOnly, localOnly, serverCount, diskCount }`, in `src/util.ts` beside
  the other pure helpers. Tests for: identical sets, server-only present, local-only
  present, both present.
- The no-difference path shows exactly one dialog; the difference path shows the delta
  dialog first, and cancelling it leaves the server untouched.
- An unreachable server reaches the delta dialog with the "could not check" wording —
  never the silent path.
- Manual two-device run: push a file from device B only, then run Reset on device A.
  That file must appear **by name** in the dialog.

---

### R14 🟠 — A 403 is reported first as success, then as "server unreachable"

**Where:** `src/database.ts` — `testConnection()`, `scanRemote()`, `obsidianFetch()`;
`src/indexpanel.ts` — `serverErrShort()` / `serverErrLong()`; `src/engine.ts` — the
live-sync error path

**What:** observed against a real server. CouchDB answered `GET /<db>` with **403** and
the body `{"error":"forbidden","reason":"You are not allowed to access this db."}` —
i.e. the login succeeded but the account is not a member of that database's
`_security`. Three separate things then went wrong, in sequence:

1. **The connection test reported success.** `obsidianFetch` passes `throw: false` so
   PouchDB can interpret status codes itself, and the path behind `info()` reads the
   body as JSON *without* checking the status — so the error document became the
   "database info". It carries neither `db_name` nor `doc_count`, so PouchDB filled in
   the database's own name (for a remote, the full URL) and the count came out
   `undefined`. Nothing threw, so `testConnection()` returned `ok: true` with the
   message `Connected to "https://…/vault-immo" (undefined docs).` That set
   `connectionVerified`, painted the green *"Connection & encryption ✓"* banner and
   unlocked the index view.
2. **The panel then called the server unreachable.** `scanRemote()` classifies with
   `err.status === 401 ? "auth" : err.status === 404 ? "notfound" : "network"`. 403 is
   not listed, so it falls into `network` and the card renders *"Server unreachable —
   could not reach the server (network/transport)."* The server was reached and
   answered clearly; only the wording was invented.
3. **Nothing stopped retrying.** The live feed dies on the 403, the reconcile sweep
   rebuilds it every 15 s (up to `LIVE_SYNC_RESTART_LIMIT`), and the remote scan runs
   on its own 15 s TTL — several hundred identical console errors in one session.
   `scanRemote()` already brakes for *empty* credentials, with a comment naming exactly
   this risk ("the fastest way to get throttled or locked out"). A server that keeps
   answering 403 has no such brake.

**Why it matters:** all three tell the user something untrue, and in opposite
directions — first "everything is set up", then "the server cannot be reached". The one
fact that would have resolved it in seconds, *"this account has no access to that
database"*, is the only thing never shown, even though the server said it in plain
words. Diagnosing it currently requires opening the developer console.

**Fix:**

- Check the response status before treating a body as database info, so a non-2xx
  answer becomes an error rather than a result. `testConnection()` already branches on
  `401` and `404`; add `403` — *"The server accepted your login, but this account has
  no access to the database. Add the user to the database's members."* — and have the
  catch-all branch report the status code it actually saw.
- Add a `forbidden` cause to `RemoteScan.error` beside `auth` / `notfound` / `network`,
  with panel wording that separates "answered, but refused" from "did not answer". R8
  Level 2 extends the same vocabulary for Cloudflare Access, so the two should be done
  in one style.
- Treat a repeated, unchanging refusal (401/403) as a stop condition rather than a
  transient one: stop reviving the live feed and pause the timed scan until something
  actually changes — settings edited, credentials unlocked, or a manual Force sync.
  This mirrors the guard `hasCredentials()` already provides.

**Acceptance:** unit tests over the status mapping (401 → auth, 403 → forbidden,
404 → notfound, 5xx/transport → network), one asserting `testConnection()` returns
`ok: false` for a 403 body — the regression that would otherwise pass silently — and
one asserting the retry loop stands down on a repeated 403 instead of counting to the
restart limit on every sweep.

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

### R10 🟠 — The derived-key cache grows without bound

**Where:** `src/crypto.ts` — `keyCache`, `deriveKey()`, `clearKeyCache()`

**What:** `deriveKey` caches every derived `CryptoKey` under
`base64(salt) + "|" + passphrase`, and nothing ever evicts. Because `encryptString`
and `encryptBytes` draw a **fresh random salt on every call**, each chunk written
inserts an entry whose key can never be hit again — dead on arrival. A 600 MB upload
leaves roughly 600 of them behind; a full vault upload leaves thousands.
`clearKeyCache()` exists for exactly this but is never called: `teardown()` in
`main.ts` clears only the *credential* key cache (`clearSecretKeyCache`).

**Why it matters:** it is a leak that grows with sync activity, on the platform with
the least memory to spare. Not a confidentiality problem — the cache only ever holds
keys the running session is already entitled to — so it should not be filed as one;
the cost is memory, and it lands on mobile.

**Fix:** stop caching on the encrypt path, where the entry is provably unreachable
(a fresh random salt cannot recur). Keep it on the decrypt path, which is where it
earns its place — a chunk shared by several files, or a re-read after a cache rebuild,
derives the same salt again. Bound what remains with a small LRU cap, and call
`clearKeyCache()` from `teardown()` next to `clearSecretKeyCache()`.

**Acceptance:** a unit test asserting that N encryptions leave the cache size
unchanged, and that decrypting the same payload twice derives once. Net effect on the
sync path is *less* work, not more.

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

### R11 🟡 — An `http://` server URL is accepted without a word

**Where:** `src/settings.ts` (the Server URL row), `src/database.ts` — `remoteUrl()`

**What:** nothing validates the scheme. The README and the field's own description
both say the URL must be `https`, and the code accepts `http://` and syncs happily.
Note content is end-to-end encrypted either way, but the CouchDB password travels in
the `Authorization` header in the clear on every single request.

**Why it matters:** it is a configuration slip with no feedback — everything appears
to work, so there is nothing to notice. On mobile it fails differently and no more
helpfully: the platform may refuse cleartext HTTP outright, and the user sees a
generic network error rather than the actual cause.

**Fix:** a warning, not a block, and never for loopback — `http://127.0.0.1:5984` is
the documented Docker quickstart in the README and has to keep working. When the URL
parses as `http:` and the host is not `localhost` / `127.0.0.1` / `[::1]`, show an
inline warning in the connection section and add the same cause to the `Test
connection` result. It stays a warning deliberately: someone on a trusted LAN, or
behind a tunnel that terminates TLS, may know exactly what they are doing.

**Acceptance:** a unit test over the pure predicate — `https` → ok, `http` + loopback
→ ok, `http` + remote host → warn, unparseable → warn. It is a pure function, so it
belongs in `src/util.ts` with the others.

---

### R5 ✅ — `putLocalDoc` does not always write a local document

**Where:** `src/database.ts` — `putLocalDoc()`, called with `MASTER_INFO_ID`

**What:** the method only writes a true non-replicating `_local/` document when the
id starts with `_local/`. `MASTER_INFO_ID = "couchdb-sync:masterinfo"` does not, so
that document replicates — deliberately, but the method name says otherwise.

**Why it matters:** cosmetic today. The concrete risk this created — a cleartext
device id reaching the server — is fixed (the body is encrypted when E2EE is on),
but the name is a trap for the next person adding a call.

**Fix:** rename to `putDoc` / `putRawDoc`, or split into `putLocalDoc` (asserts the
`_local/` prefix) and `putSharedDoc`. Pure refactor, no behaviour change.

**Done:** split into `putLocalDoc` / `putSharedDoc`, with `getLocalDoc` asserting the
same prefix. Not the pure refactor foreseen here — the prefix checks throw at runtime,
so the wrong id fails loudly instead of silently pushing per-device state to the
server. Four tests cover the guards.

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

## 3. New features

### R12 🔵 — Per-folder file count in the status tree

**Where:** `src/indexpanel.ts` — `renderTree()` (the `render()` closure and
`folderState()`); `styles.css`

**What:** the tree shows a folder's *state* through colour, but not its *size*. Each
store section already carries a total on the right of its header
(`.couchdb-sync-section-count` — the `2405`); folders have no equivalent, so there is
no way to see how much sits inside one without expanding it.

**Fix:** a count badge on every folder row, right-aligned immediately left of the `⋯`
button, showing the number of files in the **whole subtree** (nested folders
included).

- The row is already a flex line whose name span carries `flex: 1`, so inserting the
  badge between the name and `iconBtn(...)` lands it exactly there. No layout rework.
- Reuse the look of `.couchdb-sync-section-count` (the rounded pill) so the section
  total and the folder total read as the same thing at two levels.
- `renderTree()` is shared by all three stores, so Disk, Local cache and Remote server
  all get it from the one change.

**Watch out for two things:**

1. **Keep the `⋯` column straight.** File rows are flex as well
   (`.couchdb-sync-tree-fname` is `flex: 1`), so their button sits flush right today.
   Giving only folder rows a badge pulls the folder button left by the badge width and
   the column of `⋯` stops lining up. File rows need an empty slot of the same width.
2. **Compute state and count in ONE pass.** Today `folderState()` is called once per
   folder and walks that folder's entire subtree on each call, so a file at depth *d*
   is visited *d* times. Bolting on a second, independent count walk doubles that. A
   single post-order pass that annotates each node with `{ worst, count }` before
   rendering visits every file exactly once — which makes this feature a net
   *reduction* in the work the tree already does.

**Acceptance:** the annotation pass is pure (tree node → `{ worst, count }`) and
unit-testable with no DOM: nested folders sum correctly, an empty folder reads 0, and
the root count equals the section total. Visually, the `⋯` column stays aligned across
folder and file rows.

---

### R8 🔵 — Cloudflare Tunnel support (optional)

Put a Cloudflare Tunnel in front of CouchDB so the server needs no open port, no
public IP and no manually managed certificate. **Not implemented — specified here so
it can be built as one piece.**

Two levels, and they need very different amounts of work:

**Level 1 ✅ — plain tunnel, public hostname.** Works with no code change:
`cloudflared` publishes the CouchDB as `https://couch.example.com`, and the user types
that URL into the existing server field. The tunnel is invisible to the plugin.

**Done:** documented as *Option C* in the README's *Getting a server* section, with
two warnings that matter more than the setup itself — a tunnel hides where the server
is but does not lock the door, and an Access policy in front of the hostname breaks
sync outright until Level 2 ships.

**Level 2 — tunnel protected by Cloudflare Access.** This is the actual feature. With
a Zero Trust policy in front of the hostname, an unauthenticated request is answered
with a redirect to a login page, not with CouchDB. Machine clients authenticate with
a **service token**: two headers on every request, `CF-Access-Client-Id` and
`CF-Access-Client-Secret`.

**Design:**

- **Settings:** a toggle `cfAccessEnabled` (default off) plus two **separate,
  labelled** fields for the client id and the client secret, shown in the connection
  section only when the toggle is on. Default off means existing configurations are
  untouched. The secret is a password input, with a Test button beside it.

  Two named fields rather than one free-form "custom headers" box, deliberately: a
  free box is more flexible, but the most common mistake is a mistyped header name,
  and that surfaces as a silent 403 indistinguishable from a wrong password. Two
  labelled fields remove the failure mode instead of documenting it. (Cloudflare also
  supports `read_service_tokens_from_header` to carry both values in a single header
  such as `Authorization` — worth knowing when someone later asks for a custom-header
  option, not worth building first.)

- **The credentials do NOT go into `data.json` at all** — not even sealed. They belong
  in `app.saveLocalStorage()`, which is vault-scoped, lives outside the vault folder
  and is never written by `saveData()`.

  This deliberately departs from the mechanism 0.40.0 built for the CouchDB password.
  The reasoning: the sealed blob's security ceiling is exactly "localStorage is safe",
  because the device key that opens it lives there. Putting the token straight into
  localStorage is therefore **equally strong against local disk access and stronger
  against everything that carries the vault onward** — backups, file sync, a repo
  mirror, a pasted bug report — because it is not in `data.json` in any form.

  It also removes work rather than adding it: no extension of `Secrets` in
  `src/secrets.ts`, nothing to thread through `sealSecrets` / `unsealSecrets` /
  `decideSealAction` / `toPersisted`, and **no schema migration v7**. The credential
  path that already holds the user's password stays untouched.

  Two consequences to write down in the code, or the next reader will rightly ask:
  two credentials now use two different mechanisms — justified because an Access
  service token *should* be issued per device (revocation granularity) while the
  CouchDB password is the same everywhere; and localStorage is plaintext on disk and
  is lost when app data is cleared, so the token has to be re-entered on that device.

  The precedent is [obsidian-git's `localStorageSettings.ts`](https://deepwiki.com/Vinzent03/obsidian-git/10-integration-with-other-tools),
  which splits device-specific settings out of `data.json` exactly this way.
  [LiveSync issue #773](https://github.com/vrtmrz/obsidian-livesync/issues/773) asks
  for the same thing — still open, no maintainer response, so a model rather than a
  precedent there.
- **Header injection:** `obsidianFetch()` in `src/database.ts` builds the header map
  for every request PouchDB makes. It currently takes no arguments; give it the
  settings (or a header supplier) so both the replication handle from
  `connectRemote()` and the direct `scanRemote()` carry the headers. One place, both
  paths — anything less means replication authenticates and the panel does not, or
  the reverse.
- **Handle invalidation:** the remote handle bakes its fetch in at construction, so
  editing the token must call `closeRemote()` — exactly the trap the password fell
  into before 0.40.0. Wire it into the existing `invalidateConnection()`.
- **Error mapping — three cases, not two.** The obvious pair is "wrong password" and
  "wrong token". There is a third, and it is the one nobody diagnoses unaided:

  | Response | Cause | What to say |
  |---|---|---|
  | 401 with JSON | CouchDB rejected the login | check user name and password |
  | 403 | Access rejected the service token | check the token, or it expired |
  | 302 / HTML instead of JSON | Access policy is **not** set to *Service Auth* | set the policy action to Service Auth |

  The third case is what an Access application does by default: it answers an
  unauthenticated request with a redirect to an identity-provider login page. Setting
  the policy action to **Service Auth** is what suppresses that prompt for machine
  clients. Without handling it, an HTML login page reaches a JSON parser and the user
  is told something unreadable about a syntax error.

  Add the causes alongside the existing `auth` / `notfound` / `network` in
  `RemoteScan`. That vocabulary already exists — this extends it rather than inventing
  a parallel one.

  **Unverified:** Cloudflare's documentation does not state which status code Access
  returns for a missing or invalid service token. The table above is the expected
  shape; confirm each row against a real tunnel before relying on the wording.

**Risks to verify against a real tunnel before shipping:**

- **Idle timeout vs. the live feed — probably already solved, still measure.**
  Continuous replication holds a long-poll `_changes` request open, and Cloudflare
  closes connections idle for 100 s on the free and pro plans (only Enterprise can
  change it). But PouchDB's HTTP adapter appends `heartbeat=10000` to every changes
  request unless told otherwise, and CouchDB then emits a blank line every 10 seconds
  — so the connection is never idle for 100 s in the first place.

  That turns an open question into a specific one: watch a live feed for several
  minutes and confirm the heartbeat traffic is what keeps it up, rather than watching
  blindly for a disconnect that may never come. If it does drop, the fix is a shorter
  heartbeat, not new machinery — and `LIVE_SYNC_RESTART_LIMIT` plus the mobile resume
  recovery are the existing backstops.
- **Request body limits.** Cloudflare caps request bodies (100 MB on the free plan).
  `CHUNK_SIZE` is 1 MiB so a single chunk is safe, but a large `_bulk_docs` batch is
  worth checking against the cap.
- **Service token expiry.** Service tokens expire. A clear, non-cryptic message when
  a previously working setup starts returning 403 is part of the feature, not a
  follow-up.

**Acceptance:**

- Unit tests: headers present when the toggle is on and absent when off; and — the
  one that guards the whole storage decision — that `toPersisted()` output contains
  neither the client id nor the secret, so a regression that routes them back through
  `saveData()` fails the build rather than shipping.
- A manual verification against a real tunnel: each row of the error table confirmed,
  and the live feed observed for several minutes with the heartbeat behaviour written
  down.
- README: Level 1 is documented (Option C); replace its "do not use Access" warning
  with the setup once the toggle exists.

---

## 4. Accepted, no action

Carried over so nobody re-opens them without new information.

| Item | Why it stays |
|---|---|
| **History id leaks an 8-char hash prefix** | The tail is a hash of the child-id list, not a chunk id, so it reveals version-content equality and timestamp correlation — both already disclosed in the README as residuals. Changing the id format breaks stored data. |
| **Change detection compares mtime + size only** | A content hash on every stat call would defeat the fast path. The failure mode — an in-place edit that preserves both size and mtime — is rare, and the reconcile sweep catches the common variants. |
| **Migration re-unions the hidden-exclude defaults** | It runs once (gated on `priorVersion < 1`), so a config that predates an entry gets it, and a deliberate later removal is respected. Both halves are intended. |
| **`.git/` is excluded by configuration, not by a hard rule** | It ships in `DEFAULT_HIDDEN_EXCLUDE`, it is visible in the *"…except these"* field, and it can be removed. That is the design: nothing is protected from the user, everything is configured in one place the user can read. A 0.32.0 review asked for it to be enforced in code so no setting could opt back in — **declined**, because it would take away a choice that is legitimately the user's. The walk is already pruned at the folder level (`shouldWalkHiddenDir`), so an excluded `.git/` also costs nothing to skip. No warning either: the settings already show what is excluded. |
| **Chunk dedup reveals repetition structure** | Identical plaintext chunks share an id, so the server sees which pieces repeat. Inherent to content-addressed dedup, and disclosed in the README. |
| **Initial index is serial** | One file per event-loop tick keeps the UI responsive. The two things that made it pathological — walking `.git/`, and re-serializing the whole state map per file — are both fixed (hidden-walk pruning and 64-way state sharding). |

---

## 5. Suggested grouping for the next release

| Release | Contents |
|---|---|
| **Next** | R13, R9, R14, R10, R11, R12, R2, R3 (option 1), R6, R7 |
| **The one after** | R4, R8 (Level 2), R3 (option 2 — chunk-wise append) |

**R13 is next, before anything else.** It is the only open item with *no workaround*:
a vault holding a Node project cannot be made to stop syncing it, by any setting, and
every file it drags in is hashed, encrypted, replicated and re-walked on every index
refresh. R9 follows because it is the one place the plugin destroys data *on the
user's own instruction* while withholding what that instruction will cost. R14 comes
third for the opposite reason — it is small, it is reproduced, and it currently tells
the user the opposite of the truth twice in a row. R10, R11 and R12 ride along because
each is an afternoon's work and none touches sync behaviour. R6 and R7 belong in the
same release because they cover the paths R2 and R3 touch. R8 Level 2 is additive and
independently testable, so it blocks nothing and can slip without consequence.
