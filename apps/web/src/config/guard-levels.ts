/**
 * 大航海三档的**唯一色表** —— 等级身份色,和皮肤无关。
 *
 * 与 `push-features.ts` 同类:那张按「推送的是哪件事」上色,这张按「上的是哪一档舰」。
 * 两者都是产品语言,不跟皮肤换装 —— 皮肤把两档调成同一个色,用户就分不出总督和舰长了。
 * 和 `section-accents.ts` 那张**不是**一回事,后者是「这一屏讲哪件事」的装饰角光。
 *
 * 收编前 `Cards.tsx` 与 `rules/sections.tsx` 各存一份,同三个等级配出六个色。留下的是
 * Cards 那套(蓝 → 紫 → 玫红,由低到高),因为另一套的总督色**就是** `PUSH_TONE.membership`
 * —— 那抹橙在全站代表「上舰这件事」,而这两屏讲的正好都是上舰,再让它兼任「总督」这一档
 * 就把「事件」和「等级」压进了同一个色。
 *
 * 字段刻意不叫 `tone`:本仓库里 `tone` 特指推送家族色。
 */

/** B 站的 `guard_level`:1 = 总督、2 = 提督、3 = 舰长,**数字越小档越高**。 */
export type GuardLevel = 1 | 2 | 3;

/** 档的 key:配置里 `templates.membership.guard.tiers` 的键,也是会员事件上 `tier.key`(总督 / 提督 / 舰长)。 */
export type GuardRoleKey = "governor" | "commander" | "captain";

/**
 * B 站会员体系(大航海)的 id —— 设置里按体系存的东西(`templates.membership`、`membership.minRank`、订阅覆盖里的同名两段)的键。
 * 与 `@bilibili-notify/internal` 里的 `GUARD_PROGRAM_ID` 是同一个值同一个名字:面板不能从 internal 根入口取值(根入口会把 zod 拽进
 * 浏览器 bundle),所以这里留一份;㉓e 面板改读档位表、删掉这个文件时一并去掉。下面的 `rank` 同理。
 */
export const GUARD_PROGRAM_ID = "guard";

/**
 * 按 `guard_level` 升序(= 档位由高到低)。要「由低到高」的一屏自己 `.reverse()`。
 * `rank`(㉓d 起,门槛 `membership.minRank.guard` 存的就是它):从 1 起、1 最低 —— 舰长 1、提督 2、总督 3,与 `guard_level` 倒着来。
 */
export const GUARD_LEVELS = [
	{ level: 1, rank: 3, key: "governor", label: "总督", color: "#e84393" },
	{ level: 2, rank: 2, key: "commander", label: "提督", color: "#a29bfe" },
	{ level: 3, rank: 1, key: "captain", label: "舰长", color: "#74b9ff" },
] as const satisfies ReadonlyArray<{
	level: GuardLevel;
	rank: number;
	key: GuardRoleKey;
	label: string;
	color: string;
}>;
