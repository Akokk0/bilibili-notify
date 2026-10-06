import type { Subscription } from "@bilibili-notify/internal";

/** 认得出订的是谁、带着订阅 id 的最小订阅形状 —— 线上的 DTO、测试里的半截订阅都能直接传。 */
export type KeyedSubscription = Pick<Subscription, "id" | "identity">;

/**
 * 统计的来源适配看订阅看这几样:订的是谁(身份)、订阅 id、启用着没有,以及两格算好的「在记」条件
 * (ADR-0027 决策 2):`recordsPosts` = 启用着 ∧ 作品开关开着;`recordsLive` = 启用着 ∧ 直播类开关任一开着。
 * 开关取**有效值**(订阅覆盖合并全局默认之后),在提供订阅清单的地方(`runtime/bootstrap.ts`)算好,适配不认配置。
 */
export type StatsSubscription = KeyedSubscription & {
	enabled: boolean;
	recordsPosts: boolean;
	recordsLive: boolean;
};

/**
 * 一条订阅在统计仓与粉丝仓里的**文件键**:就是**订阅 id**(ADR-0020 决策 2 的 🔗)。
 *
 * 盘上的键因此与统计行的键(决策 1 的 🔗)、锐评的回指是同一个,uid / 外部 id 退成只管
 * 「这是谁」。订阅 id 是 UUID(schema 钉着),当文件名安全,也不会与老的数字 uid 文件撞名。
 *
 * 0.x 的 B 站文件按 uid 命名(`<uid>.jsonl`),由迁移器并进来,见 `migration/stats.ts`。
 */
export function statsFileKey(sub: Pick<KeyedSubscription, "id">): string {
	return sub.id;
}
