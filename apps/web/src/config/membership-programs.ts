/**
 * 面板读「会员体系有哪几档」的**唯一一扇门**。
 *
 * 3a 由 `/api/sources` 下发 `descriptor.membershipPrograms`、面板按来源描述符取档之前,这个文件是它的**替身**:
 * 里面的体系表直接读 `packages/internal` 的 B 站档位表。规则页(门槛、上舰文案)、逐订阅编辑器、卡片预览都经这里给的中立
 * 取数函数拿档,**不许**自己去 import B 站的常量(`membership-programs.test.ts` 钉着:全面板只有这一个文件认得它)。
 * 3a 到了,只改这个文件的内部,各处的调用不动。
 *
 * 取数函数吐出的都是中立形状 {@link MembershipProgram} / {@link MembershipTier};档色用 `tier.color`,面板不读 `colorEnd`
 * (那是卡背景渐变的止色)。从 `@bilibili-notify/internal/bilibili-guard` 子路径取值:根入口会把 zod 拽进浏览器。
 */

import type { MembershipProgram, MembershipTier } from "@bilibili-notify/internal";
import { BILIBILI_GUARD_PROGRAM, GUARD_PROGRAM_ID } from "@bilibili-notify/internal/bilibili-guard";

export type { MembershipProgram, MembershipTier };

/** B 站会员体系(大航海)的 id —— 设置里按体系存的东西(`templates.membership`、`membership.minRank`)的键。 */
export { GUARD_PROGRAM_ID };

const PROGRAMS: readonly MembershipProgram[] = [BILIBILI_GUARD_PROGRAM];

/** 一个体系的档,按 rank 由低到高;体系不存在、或档位由主播自定(`custom`)时回空表。回的是副本,随便排序。 */
export function membershipTiersOf(programId: string): MembershipTier[] {
	const program = PROGRAMS.find((p) => p.id === programId);
	if (!program || program.tiers === "custom") return [];
	return [...program.tiers].sort((a, b) => a.rank - b.rank);
}

/** 按 key 找一个体系里的一档;找不到回 `undefined`。 */
export function membershipTierOf(programId: string, key: string): MembershipTier | undefined {
	return membershipTiersOf(programId).find((tier) => tier.key === key);
}
