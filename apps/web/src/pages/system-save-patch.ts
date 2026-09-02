/**
 * System 页保存时发哪些顶层块 —— **改了哪块发哪块**,从草稿与基线的 diff 推出来,没有手写清单。
 *
 * 不能整份草稿发出去:后端收到 `defaults.cardStyle` / `defaults.ai` 会跑 puppeteer 与
 * chat.completions 探测,而 `buildPatch` 又刻意不做「相同就省略」(见它的注释),整份发就等于
 * 每次保存都探测一遍。所以先挑块:哪个顶层块在草稿里与基线不同,就把那一块整份交给 `buildPatch`。
 *
 * 挑块用的是灵动岛同一把尺子(`walkTreeDiff`):岛上列出来的每一行,保存时必然在补丁里。
 * 这页曾靠一份手抄的块清单挑块,链接解析那张卡就漏过一次 —— 表现为「点了保存,草稿岛又弹
 * 出来」(服务端根本没收到,原样返回,diff 还在)。清单要人记得加,尺子不用。
 *
 * 清空的可选字段(master.targetId / app.userAgent / 各模块 logLevels)由 buildPatch 与基线
 * 一比自动变成显式 `null`,不用逐个手写 `?? null`。
 */

import { buildPatch } from "@bilibili-notify/internal/patch";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { walkTreeDiff } from "../utils/walkTreeDiff";

export function buildSystemPatch(next: GlobalConfig, base: GlobalConfig): GlobalConfigPatch {
	const touched = new Set<string>();
	for (const d of walkTreeDiff(base, next)) touched.add(d.code.split(".")[0] ?? d.code);
	const pick = (g: GlobalConfig): Partial<GlobalConfig> => {
		const out: Record<string, unknown> = {};
		for (const key of touched) if (key in g) out[key] = g[key as keyof GlobalConfig];
		return out as Partial<GlobalConfig>;
	};
	return buildPatch(pick(next), pick(base)) as GlobalConfigPatch;
}
