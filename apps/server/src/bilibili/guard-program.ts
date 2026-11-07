/**
 * B 站大航海的唯一运行时档位表。guard_level 与 rank 的倒序换算只住这里。
 * 名称与宣告语访问时取当前语言;来源实例另存徽章引用,经描述符交给面板与出图器。
 */

import type { MembershipProgram, MembershipTier } from "@bilibili-notify/internal";
import { t } from "./i18n.js";

/** 官方徽章图。来源经 ctx.fetchImage 存进图库,核心只读描述符里的引用。 */
const BADGE_BASE = "https://s1.hdslb.com/bfs/static/blive/live-pay-mono/relation/relation/assets/";

// 按 rank 升序:舰长(1)→ 提督(2)→ 总督(3)。
const GUARD_TIERS: MembershipTier[] = [
	{
		key: "captain",
		get name() {
			return t("bilibili.guard.captain.name");
		},
		rank: 1,
		color: "#4ebcec",
		colorEnd: "#b494e5",
		icon: { url: `${BADGE_BASE}captain-Bjw5Byb5.png` },
		get announcement() {
			// 保留卡片模板占位符,观众名与主播名由出图器在渲染时填入。
			return t("bilibili.guard.captain.announcement", { viewer: "{viewer}", name: "{name}" });
		},
	},
	{
		key: "commander",
		get name() {
			return t("bilibili.guard.commander.name");
		},
		rank: 2,
		color: "#d8a0e6",
		colorEnd: "#b494e5",
		icon: { url: `${BADGE_BASE}supervisor-u43ElIjU.png` },
		get announcement() {
			// 保留卡片模板占位符,观众名与主播名由出图器在渲染时填入。
			return t("bilibili.guard.commander.announcement", { viewer: "{viewer}", name: "{name}" });
		},
	},
	{
		key: "governor",
		get name() {
			return t("bilibili.guard.governor.name");
		},
		rank: 3,
		color: "#f2a053",
		colorEnd: "#ef5f5f",
		icon: { url: `${BADGE_BASE}governor-DpDXKEdA.png` },
		get announcement() {
			// 保留卡片模板占位符,观众名与主播名由出图器在渲染时填入。
			return t("bilibili.guard.governor.announcement", { viewer: "{viewer}", name: "{name}" });
		},
	},
];

/**
 * B 站的会员体系 id。设置里的 `templates.membership` 与 `membership.minRank` 按它索引。
 */
export const GUARD_PROGRAM_ID = "guard";

export const GUARD_PROGRAM: MembershipProgram = {
	id: GUARD_PROGRAM_ID,
	get name() {
		return t("bilibili.guard.name");
	},
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
