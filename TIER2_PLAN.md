# Tier 2 — Query/load performance plan (DEFERRED)

Status: **not started, intentionally deferred.** Tier 1 is already implemented in the
working tree (see "Context" below). Tier 2 is a scaling fix — only start it when word
counts actually grow. Trigger: **any user crosses ~300–500 words, OR first-login load
feels slow.** Until then this is premature optimization; downloading everything is fast
at small scale.

---

## Context: what's already done (Tier 1)

Implemented in `src/App.jsx` (uncommitted working tree as of this plan):

- **Change B — O(1) progress write.** `answer()` now calls `saveOneProgress(uid, wordId, val)`,
  which writes only the one changed entry via `dbSet(users/{uid}/meta/progress, {data:{[wordId]:val}})`
  (`{merge:true}` deep-merges). Payload no longer scales with vocabulary size.
  NOTE: progress still lives in the single `meta/progress` map doc — Tier 2 replaces that.
- **Change C — per-session in-memory cache.** `_cache` Map + `cachedGetAll` / `cachePush` /
  `cacheRemove` / `clearDataCache`. Shared collections load once per session; tab switches are
  cache hits. All mutation handlers keep it in sync; cleared on logout.
- **Change A (persistence) was evaluated and REJECTED** — it added ~24 kB gzip to first load
  without reducing online reads, hurting the cold-load speed we care about. Kept plain `getFirestore`.

Also done earlier this session (mobile UX): `index.html` cross-engine no-translate
(`translate="no"` + `notranslate` + google meta), font preconnect, `viewport-fit=cover`;
`src/App.jsx` mobile CSS (16px inputs, `100dvh`, bigger tap targets), `translate="no"` on flashcard.

---

## The problem Tier 2 solves

The Learn tab cold load scales with **total words owned**, not **cards due today**. On first
login it downloads: all `global_words`, all `users/{uid}/words`, the whole `global_translations/{lang}/words`
overlay, the entire progress map, and folders — then filters "due" client-side (`isDue`).
Goal: make the cold load scale with cards due today.

---

## Centerpiece: per-word progress + due-query

**Schema:** `users/{uid}/meta/progress` (one big map) → `users/{uid}/progress/{wordId}` = `{ level, due }`.
This also completes Change B (single-doc writes, no 1 MiB ceiling ever).

**Read path (LearnTab):** replace "load everything + client filter" with:
```js
query(collection(db, `users/${uid}/progress`), where("due","<=",Date.now()), orderBy("due"), limit(PAGE))
```
then fetch content for that page of wordIds (batched `in` queries, 30/batch, or per-doc),
with `startAfter` cursor pagination for "next batch."

**Write path:** `answer()` → `setDoc(users/{uid}/progress/{card.id}, nextReview(...))`.

### The core design fork (DECIDE BEFORE CODING 2b)

A never-reviewed word has **no progress doc**, so a naive due-query skips brand-new words.
Two ways to resolve — the choice depends on whether slow users have many **personal** words
or a large **course**:

- **Option 1 — Uniform collection + seeding.** Every word gets a `{due:0}` progress doc so
  it's query-visible. Personal words: write the progress doc at creation (`WordsTab.addWord`).
  Global words: one-time onboarding batch-seed, + incremental seed for new course words via a
  `createdAt` cursor (add `createdAt` to global words; id already embeds `Date.now()`).
  Simpler single code path. Needs seeding.
- **Option 2 — Hybrid, no seeding.** Store `level`/`due` **directly on the personal word doc**
  → `users/{uid}/words where(due<=now) limit()` returns content+due in one query, no join.
  Global words still need per-user progress docs. More optimal, two code paths.

Recommend Option 1 (uniform) unless personal words dominate the scale.

---

## Migration — RECOMMENDED APPROACH: dual-read fallback (no batch job)

At this app's scale, **do NOT run a batch migration.** Instead ship 2b with a dual-read
fallback so old progress migrates organically and nothing resets:

- **Writes** always go to the new `progress/{wordId}` doc.
- **Reads** try the subcollection; for any word with no doc yet, fall back to the old
  `meta/progress.data` map. Data migrates as users review; the map becomes vestigial.
- Cost: carry a small fallback path for a release or two, then delete it + the old map.

Why not a batch migration: risk (SRS correctness, idempotency window, coordinated rules+deploy)
isn't worth it for a small dataset. Migration ≠ seeding — migration moves *existing reviewed*
progress; seeding creates due=0 docs for *never-reviewed* words (only needed for Option 1).

### If a batch migration is ever wanted anyway (larger scale)

Use an **admin script** (they have `firebase-admin` + `api/_firebase.js` `getDb`), not
client-side. Sketch:
```js
// scripts/migrate-progress.mjs — run against TEST project first (DRY_RUN=1), then prod.
const users = await db.collection("users").listDocuments();
for (const userRef of users) {
  const metaRef = userRef.collection("meta").doc("progress");
  const meta = await metaRef.get();
  const data = meta.exists ? (meta.data().data || {}) : {};
  if (meta.data()?.migrated || !Object.keys(data).length) continue;   // idempotent skip
  const col = userRef.collection("progress");
  const entries = Object.entries(data);
  for (let i = 0; i < entries.length; i += 450) {                     // <500 batch cap
    const batch = db.batch();
    for (const [wid, v] of entries.slice(i, i+450)) batch.set(col.doc(wid), {level:v.level??0, due:v.due??0});
    await batch.commit();
  }
  await metaRef.set({ migrated: true }, { merge: true });             // keep .data for rollback
}
```
- Idempotency hazard: a review landing *after* migrate but *before* the flag → re-run `set()`
  overwrites the fresh value. Avoid by running in a quiet window (admin) or blocking `answer()`
  until `migrated===true` (client-lazy). Keep old `.data` for lossless rollback; delete later.

---

## Firestore rules (HARD DEPLOY DEPENDENCY)

New subcollection hits the default-deny (`firestore.rules:83`). Add under `match /users/{uid}`:
```
match /progress/{wordId} {
  allow read:  if isOwner(uid);
  allow write: if isOwner(uid)
               && request.resource.data.level is int
               && request.resource.data.level >= 0 && request.resource.data.level <= 5
               && request.resource.data.due is int;
}
```
Deploy order: **(1) deploy rules → (2) deploy app code reading/writing the new path.**
(Dual-read fallback means no separate migration step to sequence.)

---

## Supporting items (independent, optional)

- **Drop the bulk translation overlay (cheapest win, do first / independently).** Remove
  `loadLangTranslations` from LearnTab's load; rely on per-card `ensureTranslation` (server
  cache hit is cheap — see `api/translate.js`, cache checked before rate-limit/upstream).
  Removes the fastest-growing collection download from every Learn load. UX: `ru2de` front
  briefly shows the `…` placeholder. Also fixes a latent redundant-call issue (no `c.ru`
  language-correct guard today).
- **Word-list rendering (WordsTab).** At thousands of rows the jank is DOM rendering, not the
  query. Window it (`react-window`, adds dep) or `limit`+`startAfter` "load more". Caveat:
  Firestore has no substring search, so `🔍 Suchen…` only covers loaded rows without a search
  index (Algolia/Typesense). Only do this if the Words tab is actually slow.

---

## Recommended rollout order

1. **Stage 2a:** drop the translation overlay (low risk, immediate, no migration).
2. **Stage 2b:** per-word progress + due-query, with **dual-read fallback** (no batch job),
   rules deployed in lockstep. Decide the Option 1 vs 2 fork first.
3. Word-list virtualization only if needed.

## Open question to answer before 2b implementation
Do slow users have many **personal** words or a large **course**? → picks Option 1 vs 2.
