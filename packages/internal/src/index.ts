/**
 * Internal access token for @bilibili-notify/* workspace packages.
 * This package is private and must not be published to npm.
 * Only packages that depend on this package can obtain the token
 * and call ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN).
 */
export const BILIBILI_NOTIFY_TOKEN = Symbol("bilibili-notify");
