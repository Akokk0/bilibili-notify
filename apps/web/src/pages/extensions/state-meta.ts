import type { ExtensionStateDTO } from "@bilibili-notify/contract";

/**
 * 拓展的运行状态 → 说给主人听的那句话 + 状态点的档位 + 「有多糟」。
 *
 * **一份**,列表页与详情页共用 —— 抄两份的下场是同一个拓展在两页上说着不同的话,
 * 而两边都不会报错。
 *
 * 🔴 状态与主人按的那个开关是**两件事**:开着却没跑(连败自动停用 / 清单坏了 / 版本不合)
 * 恰恰是最需要看见的那一格,所以两样都要印。
 */
export const EXTENSION_STATE_META: Record<
	ExtensionStateDTO,
	{ label: string; dot: "ok" | "off" | "warn" | "err"; severity: "none" | "warn" | "err" }
> = {
	running: { label: "运行中", dot: "ok", severity: "none" },
	disabled: { label: "已停用", dot: "off", severity: "none" },
	blocked: { label: "已自动停用", dot: "warn", severity: "warn" },
	failed: { label: "加载失败", dot: "err", severity: "err" },
	unreadable: { label: "清单读不出来", dot: "err", severity: "err" },
	incompatible: { label: "版本不合", dot: "warn", severity: "warn" },
};
