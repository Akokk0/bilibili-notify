/**
 * 链接解析 `linkParsing` 的 0.x 老形状两步,文件名与函数名留着 0.x 盘上的叫法(先例:`feature-renames.ts`):
 *
 * 1. 0.9.1 的「范围 + 白名单」(`scope` + `targets`)→ 0.x 最新的默认行 + 例外(`defaults` + `groups`)
 *    ({@link migrateLegacyLinkParsing})。⑥c 从 internal 的 `LinkParsingConfigSchema` preprocess 里原样收进来。
 * 2. 0.x 最新的 `linkParsing { enabled, cooldownSeconds, defaults: { parse, form }, groups }` → 1.0 的
 *    `linkPreview { enabled, isOnByDefault, replyForm, byTarget, cooldownSec }`({@link renameLinkParsing}),
 *    回复形式 `miniapp` 叫 `nativeShare`。
 */

import { isPlainObject } from "./files.js";

/**
 * 0.9.1 的「范围 + 白名单」→ 默认行 + 例外。只在老键在、新键不在时迁;新旧键同时出现
 * (补丁合并进老数据)认新的,老键丢掉。all 下的 `targets` 本来就不起作用,不带过来。
 */
export function migrateLegacyLinkParsing(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const r = raw as Record<string, unknown>;
	if (!("scope" in r) && !("targets" in r)) return raw;
	const { scope, targets, ...rest } = r;
	if ("defaults" in rest || "groups" in rest) return rest;
	const selected = scope === "selected";
	const groups: Record<string, { parse: true }> = {};
	if (selected && Array.isArray(targets)) {
		for (const t of targets) {
			const id = (t as { targetId?: unknown } | null)?.targetId;
			if (typeof id === "string") groups[id] = { parse: true };
		}
	}
	return { ...rest, defaults: { parse: !selected, form: "image" }, groups };
}

/** 回复形式的取值:0.x 的 `miniapp` 叫 `nativeShare`,其余(包括认不得的)原样。 */
function renameReplyForm(form: unknown): unknown {
	return form === "miniapp" ? "nativeShare" : form;
}

/** 一格一格搬:旧键在才出新键,缺的格照缺(由 schema 补默认),值认不得的原样搬、由配置仓开机报。 */
function linkParsingToPreview(old: unknown): unknown {
	if (!isPlainObject(old)) return old;
	const out: Record<string, unknown> = {};
	if ("enabled" in old) out.enabled = old.enabled;
	if ("cooldownSeconds" in old) out.cooldownSec = old.cooldownSeconds;
	if (isPlainObject(old.defaults)) {
		if ("parse" in old.defaults) out.isOnByDefault = old.defaults.parse;
		if ("form" in old.defaults) out.replyForm = renameReplyForm(old.defaults.form);
	}
	if ("groups" in old) {
		const groups = old.groups;
		out.byTarget = isPlainObject(groups)
			? Object.fromEntries(Object.entries(groups).map(([id, entry]) => [id, targetEntryOf(entry)]))
			: groups;
	}
	return out;
}

/** 例外条目:`parse` → `isOn`,`form` → `replyForm`;不是对象的原样。 */
function targetEntryOf(entry: unknown): unknown {
	if (!isPlainObject(entry)) return entry;
	const out: Record<string, unknown> = {};
	if ("parse" in entry) out.isOn = entry.parse;
	if ("form" in entry) out.replyForm = renameReplyForm(entry.form);
	return out;
}

/**
 * 整份核心设置的 raw → raw:`linkParsing` 改成 `linkPreview` 五格。
 *
 * - 总开关 `enabled` 单独一格、原样搬 —— 0.x 的门先看它、再看逐群答案,所以它**不能**折进默认行:
 *   折进去的话,总开关关着、例外里显式开的群会从「不回」变成「回」;
 * - `defaults.parse` → `isOnByDefault`;`defaults.form` → `replyForm`(`miniapp` → `nativeShare`);
 *   `groups` → `byTarget`(键仍是目标 id,条目里 `parse` → `isOn`、`form` → `replyForm`);`cooldownSeconds` → `cooldownSec`;
 * - 新旧两把键同时在,`linkPreview` 说了算、`linkParsing` 丢掉;没有 `linkParsing` 原样放过(再跑一遍不变);
 * - `linkParsing` 不是对象或某格的值认不得,原样搬到新键下,由配置仓开机报。
 */
export function renameLinkParsing(raw: unknown): unknown {
	if (!isPlainObject(raw) || !("linkParsing" in raw)) return raw;
	const { linkParsing, ...rest } = raw;
	if ("linkPreview" in rest) return rest;
	return { ...rest, linkPreview: linkParsingToPreview(linkParsing) };
}
