import type { ExtensionStateDTO } from "@bilibili-notify/contract";

/**
 * 拓展的运行状态 → 卡片头上那枚徽章说什么、整张卡染什么色、「有多糟」。
 *
 * **一份**,列表页与详情页共用 —— 抄两份的下场是同一个拓展在两页上说着不同的话,
 * 而两边都不会报错。
 *
 * 🔴 状态与主人按的那个开关是**两件事**:开着却没跑(连败自动停用 / 清单坏了 / 版本不合)
 * 恰恰是最需要看见的那一格 —— 所以徽章印的是状态,开关另有开关。「已启用 / 已关闭」是
 * 设计稿上的两个词,只给「开着且跑着」与「关着」这两档;其余几档各说各的。
 */
export const EXTENSION_STATE_META: Record<
	ExtensionStateDTO,
	{ label: string; accent: string; severity: "none" | "warn" | "err" }
> = {
	running: { label: "已启用", accent: "var(--color-bn-pink)", severity: "none" },
	disabled: { label: "已关闭", accent: "var(--color-bn-inactive)", severity: "none" },
	blocked: { label: "已自动停用", accent: "var(--color-bn-warning)", severity: "warn" },
	failed: { label: "加载失败", accent: "var(--color-bn-danger)", severity: "err" },
	unreadable: { label: "清单读不出来", accent: "var(--color-bn-danger)", severity: "err" },
	incompatible: { label: "版本不合", accent: "var(--color-bn-warning)", severity: "warn" },
	staged: { label: "新版等着换上", accent: "var(--color-bn-warning)", severity: "warn" },
	/*
	 * 存着的设置过不了它自己的 zod(ADR-0019 决策 36)。**不是红的**:代码没坏,是在等主人去「配置」
	 * 里改对,改对了它自己起来 —— 与「加载失败」同一个红,就会被当成要去翻日志的那一类。怎么改
	 * 由服务端那句 `detail` 说(点名哪一格,v1 另有出路)。
	 */
	"settings-invalid": { label: "设置读不了", accent: "var(--color-bn-warning)", severity: "warn" },
};
