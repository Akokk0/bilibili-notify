---
"@bilibili-notify/storage": minor
"koishi-plugin-bilibili-notify": minor
---

at-rest secrets now use AES-256-GCM with a key derived from an injected passphrase

`@bilibili-notify/storage` replaces the legacy AES-256-CBC cookie path with
authenticated AES-256-GCM and a pluggable `KeyProvider`: when a passphrase is
injected (standalone `BN_COOKIE_KEY` / `cookieEncryptionKey`) the key is
scrypt-derived and never written to disk; otherwise it falls back to the
existing co-located random key file. New exports: `gcmEncrypt` / `gcmDecrypt` /
`deriveKeyFromPassphrase` / `isGcmBlob` / `createKeyProvider` /
`PassphraseKeyProvider` / `FileKeyProvider`. `EncryptedFile` is removed
(`StoredCookies` now holds `GcmBlob`s).

**Upgrade impact (both ends):** cookie files written by a pre-GCM build cannot
be decrypted and are not migrated — users re-scan the QR login once after
upgrading. The koishi shell keeps the zero-config co-located-key behaviour
(no passphrase), so only the one-time re-login is user-visible there.
