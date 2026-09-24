import type { BiliSubscription, ExtensionSubscription } from "@bilibili-notify/internal";

/** 判得出是哪一支、带着订阅 id 的最小订阅形状 —— 线上的 DTO、测试里的半截订阅都能直接传。 */
export type KeyedSubscription =
	| Pick<BiliSubscription, "kind" | "id" | "uid">
	| Pick<ExtensionSubscription, "kind" | "id">;

/**
 * 一条订阅在统计仓与粉丝仓里的**文件键**:两支一样,就是**订阅 id**(ADR-0020 决策 2 的 🔗)。
 *
 * 盘上的键因此与统计行的键(决策 1 的 🔗)、锐评的回指是同一个,uid / 外部 id 退成只管
 * 「这是谁」。订阅 id 是 UUID(schema 钉着),当文件名安全,也不会与老的数字 uid 文件撞名。
 *
 * 老的 B 站文件按 uid 命名(`<uid>.jsonl`),由开机迁移并进来,见 `migrate-file-keys.ts`。
 */
export function statsFileKey(sub: Pick<KeyedSubscription, "id">): string {
	return sub.id;
}
