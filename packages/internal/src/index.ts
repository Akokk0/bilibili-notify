/**
 * Process-wide capability marker for BN Koishi plugins to access core internals.
 *
 * Koishi may load duplicated copies of @bilibili-notify/internal after plugin
 * upgrades. Symbol.for keeps friendly plugins on the same token across copies;
 * this is a misuse guard, not a security boundary inside the shared Node process.
 */
export const BILIBILI_NOTIFY_TOKEN = Symbol.for(
	"@bilibili-notify/internal/BILIBILI_NOTIFY_TOKEN/v1",
);

export * from "./platform";
export * from "./schema";
export * from "./util";
