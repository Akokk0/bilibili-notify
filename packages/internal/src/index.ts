/**
 * Access token for @bilibili-notify/* workspace packages. Only packages that
 * depend on this package can obtain the token and call
 * ctx["bilibili-notify"].getInternals(BILIBILI_NOTIFY_TOKEN).
 */
export const BILIBILI_NOTIFY_TOKEN = Symbol("bilibili-notify");

export * from "./platform";
export * from "./schema";
export * from "./util";
