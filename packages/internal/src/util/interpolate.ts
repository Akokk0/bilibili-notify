/**
 * 模板插值。语法：`{key}` 或 `{key.path}`，匹配 vars 中对应字段。
 * 未识别变量原样保留并通过 onMissing 报告，不抛错（让模板编辑期对未知变量宽容）。
 *
 * 单源化各业务模块（dynamic / live / template-renderer / live-summary）原本散落的字符串拼接；
 * 配 plan §三 "动态过滤变量混用直播变量" 修正：UI 按上下文展示可用变量，runtime 由 onMissing 兜底。
 */
export function interpolate(
	template: string,
	vars: Record<string, unknown>,
	onMissing?: (key: string) => void,
): string {
	return template.replace(/\{([\w.]+)\}/g, (raw, key: string) => {
		const value = lookup(vars, key);
		if (value === undefined) {
			onMissing?.(key);
			return raw;
		}
		return String(value);
	});
}

function lookup(scope: Record<string, unknown>, path: string): unknown {
	const segments = path.split(".");
	let current: unknown = scope;
	for (const seg of segments) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[seg];
	}
	return current;
}
