/**
 * B 站的大航海档位表(ADR-0021 决策 26 下 2026-10-05 的 🔗,㉓b)。
 *
 * 面板、引擎、出图器读同一份,不再各抄一张。`guard_level` 与 rank 的倒序换算(B 站接口 1 = 总督、3 = 舰长,
 * rank 却是 1 = 最低 = 舰长)**全仓只许出现在这一个文件里**。3a 建 `bilibili/` 时整个搬进 B 站的来源描述符
 * (`descriptor.membershipPrograms`),由 `/api/sources` 下发。
 *
 * 🔴 **一条值级 import 都不许有**(只许 `import type`):㉓e 起面板要读它,同 `constants.ts` / `format.ts` 的纪律
 * (`constants-imports.test.ts` 钉着)。
 */

import type { MembershipProgram, MembershipTier } from "./membership";

/** 官方徽章图。今天三处各抄一份(出图器、直播引擎、面板),这里是合并后的那一份;改本地资产归 3a。 */
const BADGE_BASE = "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/";

// 按 rank 升序:舰长(1)→ 提督(2)→ 总督(3)。
const GUARD_TIERS: MembershipTier[] = [
	{
		key: "captain",
		name: "舰长",
		rank: 1,
		color: "#4ebcec",
		colorEnd: "#b494e5",
		icon: { url: `${BADGE_BASE}captain-Bjw5Byb5.png` },
		announcement: '"{viewer}号"加入\n"{name}"大航海舰队！',
	},
	{
		key: "commander",
		name: "提督",
		rank: 2,
		color: "#d8a0e6",
		colorEnd: "#b494e5",
		icon: { url: `${BADGE_BASE}supervisor-u43ElIjU.png` },
		announcement: '"{viewer}"就任\n"{name}"大航海舰队提督！',
	},
	{
		key: "governor",
		name: "总督",
		rank: 3,
		color: "#f2a053",
		colorEnd: "#ef5f5f",
		icon: { url: `${BADGE_BASE}governor-DpDXKEdA.png` },
		announcement: '"{viewer}"上任\n"{name}"大航海舰队总督！',
	},
];

export const BILIBILI_GUARD_PROGRAM: MembershipProgram = {
	id: "guard",
	name: "大航海",
	tiers: GUARD_TIERS,
};

/** B 站接口的 `guard_level` → 档的 key。**倒序换算只在这里**:1 = 总督、2 = 提督、3 = 舰长,其它一律认不出。 */
const TIER_KEY_OF_GUARD_LEVEL: ReadonlyMap<number, string> = new Map([
	[1, "governor"],
	[2, "commander"],
	[3, "captain"],
]);

/** B 站 `guard_level` → 档;认不出的(0、4、负数、小数、NaN……)回 `undefined`,调用方丢弃并记一条警告。 */
export function guardTierOf(guardLevel: number): MembershipTier | undefined {
	const key = TIER_KEY_OF_GUARD_LEVEL.get(guardLevel);
	return key === undefined ? undefined : GUARD_TIERS.find((tier) => tier.key === key);
}
