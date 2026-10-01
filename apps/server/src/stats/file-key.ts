import type { SubscriptionIdentitySource } from "@bilibili-notify/internal";

/** 认得出订的是谁、带着订阅 id 的最小订阅形状 —— 线上的 DTO、测试里的半截订阅都能直接传。 */
export type KeyedSubscription = SubscriptionIdentitySource & { id: string };

/** 统计的来源适配看订阅看这几样:订的是谁(身份)、订阅 id、启用着没有。 */
export type StatsSubscription = KeyedSubscription & { enabled: boolean };

/**
 * 一条订阅在统计仓与粉丝仓里的**文件键**:两支一样,就是**订阅 id**(ADR-0020 决策 2 的 🔗)。
 *
 * 盘上的键因此与统计行的键(决策 1 的 🔗)、锐评的回指是同一个,uid / 外部 id 退成只管
 * 「这是谁」。订阅 id 是 UUID(schema 钉着),当文件名安全,也不会与老的数字 uid 文件撞名。
 *
 * 0.x 的 B 站文件按 uid 命名(`<uid>.jsonl`),由迁移器并进来,见 `migration/stats.ts`。
 */
export function statsFileKey(sub: Pick<KeyedSubscription, "id">): string {
	return sub.id;
}
