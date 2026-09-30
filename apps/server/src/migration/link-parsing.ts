/**
 * 链接解析 `linkParsing` 的 0.x 老形状:0.9.1 的「范围 + 白名单」(`scope` + `targets`)→ 默认行 + 例外
 * (`defaults` + `groups`)。⑥c 从 internal 的 `LinkParsingConfigSchema` preprocess 里原样收进来。
 */

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
