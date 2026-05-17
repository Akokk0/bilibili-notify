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
		// 仅 primitive 才插值。对象/函数/symbol 走 onMissing 原样保留:
		// 既避免 `{persona}` 静默渲染成 "[object Object]" 的噪声,也堵死
		// `{constructor}` → 函数源码、`{__proto__}` → 原型对象的链式泄露
		// (配合 lookup 的 own-property + 危险段名拦截,双保险)。
		if (
			value === null ||
			(typeof value !== "string" &&
				typeof value !== "number" &&
				typeof value !== "boolean" &&
				typeof value !== "bigint")
		) {
			onMissing?.(key);
			return raw;
		}
		return String(value);
	});
}

/** 原型污染 / 链式泄露的禁用段名。 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function lookup(scope: Record<string, unknown>, path: string): unknown {
	const segments = path.split(".");
	let current: unknown = scope;
	for (const seg of segments) {
		if (current == null || typeof current !== "object") return undefined;
		// 拒绝原型链段名,且只认自有属性 —— 杜绝 `{toString}`/`{constructor}`
		// 命中 Object.prototype 继承成员导致的原型/函数文本外泄。
		if (FORBIDDEN_SEGMENTS.has(seg) || !Object.hasOwn(current, seg)) return undefined;
		current = (current as Record<string, unknown>)[seg];
	}
	return current;
}
