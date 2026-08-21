/**
 * 大航海三档的**唯一色表** —— 等级身份色,和皮肤无关。
 *
 * 与 `push-kinds.ts` 同类:那张按「推送的是哪件事」上色,这张按「上的是哪一档舰」。
 * 两者都是产品语言,不跟皮肤换装 —— 皮肤把两档调成同一个色,用户就分不出总督和舰长了。
 * 和 `section-accents.ts` 那张**不是**一回事,后者是「这一屏讲哪件事」的装饰角光。
 *
 * 收编前 `Cards.tsx` 与 `rules/sections.tsx` 各存一份,同三个等级配出六个色。留下的是
 * Cards 那套(蓝 → 紫 → 玫红,由低到高),因为另一套的总督色**就是** `PUSH_TONE.guard`
 * —— 那抹橙在全站代表「上舰这件事」,而这两屏讲的正好都是上舰,再让它兼任「总督」这一档
 * 就把「事件」和「等级」压进了同一个色。
 *
 * 字段刻意不叫 `tone`:本仓库里 `tone` 特指推送家族色。
 */

/** B 站的 `guard_level`:1 = 总督、2 = 提督、3 = 舰长,**数字越小档越高**。 */
export type GuardLevel = 1 | 2 | 3;

/** 配置里 `templates.guardBuy` 的三个角色键。 */
export type GuardRoleKey = "governor" | "commander" | "captain";

/** 按 `guard_level` 升序(= 档位由高到低)。要「由低到高」的一屏自己 `.reverse()`。 */
export const GUARD_LEVELS = [
	{ level: 1, key: "governor", label: "总督", color: "#e84393" },
	{ level: 2, key: "commander", label: "提督", color: "#a29bfe" },
	{ level: 3, key: "captain", label: "舰长", color: "#74b9ff" },
] as const satisfies ReadonlyArray<{
	level: GuardLevel;
	key: GuardRoleKey;
	label: string;
	color: string;
}>;
