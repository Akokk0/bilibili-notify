/**
 * System 页保存时发哪些顶层块 —— **改了哪块发哪块**,从草稿与基线的 diff 推出来,没有手写清单。
 *
 * 不能整份草稿发出去:后端收到 `defaults.cards` / `ai` 会跑 puppeteer 与
 * chat.completions 探测,而 `buildPatch` 又刻意不做「相同就省略」(见它的注释),整份发就等于
 * 每次保存都探测一遍。所以先挑块:哪个块在草稿里与基线不同,就把那一块整份交给 `buildPatch`。草稿是整份设置
 * (`{ core, <集成键>… }`),核心那份的块是 `core` 下的顶层键,集成的块是集成的整份。
 *
 * 挑块用的是灵动岛同一把尺子(`walkTreeDiff`):岛上列出来的每一行,保存时必然在补丁里。
 * 这页曾靠一份手抄的块清单挑块,链接解析那张卡就漏过一次 —— 表现为「点了保存,草稿岛又弹
 * 出来」(服务端根本没收到,原样返回,diff 还在)。清单要人记得加,尺子不用。
 *
 * 清空的可选字段(master.targetId / 各模块 logging.levels)由 buildPatch 与基线
 * 一比自动变成显式 `null`,不用逐个手写 `?? null`。
 */

import type { SettingsResponse } from "@bilibili-notify/contract";
import { buildPatch } from "@bilibili-notify/internal/patch";
import type { SettingsPatch } from "../types/globals";
import { walkTreeDiff } from "../utils/walkTreeDiff";

export function buildSystemPatch(next: SettingsResponse, base: SettingsResponse): SettingsPatch {
	// 块是**两层**的:核心那份按它自己的顶层块挑(`core.logging`),各集成的设置按集成的键整份挑(`bilibili`)——
	// 整份 `core` 发出去的话,里面的 `defaults.cards` / `ai` 就跟着去了,每次保存都探测一遍。
	const coreBlocks = new Set<string>();
	const integrations = new Set<string>();
	for (const d of walkTreeDiff(base, next)) {
		const [top = d.code, block] = d.code.split(".");
		if (top !== "core") integrations.add(top);
		else if (block !== undefined) coreBlocks.add(block);
	}
	const pick = (g: SettingsResponse): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		if (coreBlocks.size > 0) {
			const from = g.core as unknown as Record<string, unknown>;
			const core: Record<string, unknown> = {};
			for (const key of coreBlocks) if (key in from) core[key] = from[key];
			out.core = core;
		}
		// 各集成的键不认得是谁的,照键挑。
		for (const key of integrations) if (key in g) out[key] = g[key];
		return out;
	};
	return buildPatch(pick(next), pick(base)) as SettingsPatch;
}
