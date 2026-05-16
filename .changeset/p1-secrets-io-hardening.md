---
"@bilibili-notify/storage": patch
"koishi-plugin-bilibili-notify": patch
---

P1 secrets IO hardening (final-sweep review, follow-up pass after P0)

Distinguishes "file absent" (silent, legit first run) from "file present but
unreadable" (must fail loud) across the at-rest secret IO layer — closing a
data-loss / silent-relogin class flagged `[both]×3` in the dual-engine review.

- **cookie-store.load() / secret-store.load()** (`@bilibili-notify/storage` +
  the non-published server): a non-`ENOENT` `readFile` error (`EACCES`/`EIO`/
  `EBUSY`/`EISDIR`) was swallowed into `null`/`{}`. A subsequent refresh-save
  then atomically overwrote the still-valid on-disk secret — permanently
  destroying a stored cookie / `aiApiKey` the user never asked to drop. Now
  only `ENOENT` degrades silently; any other read error throws. The decrypt
  failure path (legacy CBC / key change) still degrades by design.
- **kdf.salt validation** (`@bilibili-notify/storage`): the salt loader regex
  `/^[0-9a-f]{32,}$/i` accepted truncated/concatenated salts, silently
  deriving a wrong key → silent re-login + undecryptable secrets. Tightened to
  exact `{32}` (16 bytes — the only length this code ever writes); an
  invalid-but-present salt now warns loudly before regeneration, and an
  unreadable (non-`ENOENT`) salt file throws instead of silently rotating the
  key.
- **deriveKeyFromPassphrase** (`@bilibili-notify/storage`): asserts
  `salt.length >= 16` to lock the scrypt KDF invariant against upstream
  regressions.
- **fallback warning centralized** (`@bilibili-notify/storage` →
  `koishi-plugin-bilibili-notify`): the "no injected key → co-located random
  key is obfuscation, not real at-rest encryption" warning now fires at the
  `createKeyProvider` selection point, so every consumer (incl. the koishi
  shell, previously silent) gets it once per boot. The standalone server keeps
  only its `BN_COOKIE_KEY`-specific actionable hint.
- **secret-store.save()** (non-published server): fixed `.tmp` name → 
  `.tmp.{pid}.{rand}` (matches `store.ts#atomicWriteJson`), removing a
  concurrent-write race (P2 fold-in, same function).
