import { getFieldLabel } from "../config/field-labels";

/**
 * 灵动岛 diff 行的值格式化结果。
 *
 * `display` 是面板上显示的文字;color 字段额外带 `swatch` 让前端渲染色块。
 * 密钥字段(FIELD_LABELS[code].secret=true)固定脱敏为「••• 已改」,不暴露明文。
 */
export interface FormattedValue {
	display: string;
	swatch?: string;
}

const REDACTED: FormattedValue = { display: "••• 已改" };
const UNSET: FormattedValue = { display: "(未设置)" };
const EMPTY_LIST: FormattedValue = { display: "[]" };

/** 「默认文案有更新」的账本前缀;它的值是指纹,不该按字符串原样吐出来。 */
export const SEEN_PREFIX = "templateDefaultsSeen.";
const SEEN_YES: FormattedValue = { display: "已确认" };
const SEEN_NO: FormattedValue = { display: "未确认" };

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isColorCode(code: string): boolean {
	return code.toLowerCase().includes("color");
}

function isHexColor(s: unknown): s is string {
	return typeof s === "string" && HEX_RE.test(s);
}

/**
 * 把 diff 行的 oldValue / newValue 翻译成展示字符串。规则按 plan Q12:
 * - boolean → 「开启」/「关闭」
 * - color 字段(code 含 "color")→ hex 字面 + swatch(渲染端画色块)
 * - secret 字段(FIELD_LABELS.secret=true)→ 「••• 已改」(不论原值)
 * - array → 紧凑 JSON 全展开(panel max-h-60vh 自带滚动,不 truncate)
 * - plain object → 紧凑 JSON
 * - number → 字符串
 * - string → 原文
 * - null / undefined → 「(未设置)」
 *
 * 不在内部判断 oldValue vs newValue 哪个该脱敏 —— secret 字段无论新旧值都
 * 脱敏(展示「••• 已改」一个 token 即可,不显示 hex/raw 文本)。
 */
export function formatDiffValue(code: string, value: unknown): FormattedValue {
	// 走 getFieldLabel 而不是直接读字典:动态 code(逐家服务商的 `ai.providers.<家>.*`)
	// 的 secret 位是从 `ai.<字段>` 那条**继承**来的,绕过去就查不到 —— 后果是主人刚
	// 敲进去的 API Key 明文被摊在灵动岛面板上。
	const entry = getFieldLabel(code);
	if (entry?.secret) return REDACTED;

	// 「默认文案有更新」的账本:存的是内容指纹(`1hxy5zb` 这种),对用户零信息量。
	// 它在灵动岛里只需要回答一句话 ——「这条提示我确认过没有」。
	if (code.startsWith(SEEN_PREFIX)) {
		return value === undefined || value === null ? SEEN_NO : SEEN_YES;
	}

	if (value === undefined || value === null) return UNSET;

	if (typeof value === "boolean") {
		return { display: value ? "开启" : "关闭" };
	}

	if (typeof value === "number") {
		return { display: Number.isFinite(value) ? String(value) : "NaN" };
	}

	if (typeof value === "string") {
		// color 字段且是合法 hex → 带 swatch
		if (isColorCode(code) && isHexColor(value)) {
			return { display: value, swatch: value };
		}
		return { display: value === "" ? '""' : value };
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return EMPTY_LIST;
		return { display: JSON.stringify(value) };
	}

	if (typeof value === "object") {
		return { display: JSON.stringify(value) };
	}

	return { display: String(value) };
}
