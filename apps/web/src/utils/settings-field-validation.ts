import type { SettingsScalarField } from "@bilibili-notify/contract";
import { i18n } from "../i18n";

type Edit = string | boolean;

/** 数字的范围说成一句话。 */
function rangeText(min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined)
		return i18n.t("panelUi.pages.extensions.declarative.settings-form.1", {
			value0: min,
			value1: max,
		});
	if (min !== undefined)
		return i18n.t("panelUi.pages.extensions.declarative.settings-form.2", { value0: min });
	return i18n.t("panelUi.pages.extensions.declarative.settings-form.3", { value0: String(max) });
}

/** 数字框认的那种十进制写法:可带负号、小数、指数(`-1.5`、`.5`、`2e3`)。 */
const DECIMAL = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * 数字格里那串字是几;不算一个数的交 `undefined`。首尾的空格不算数,中间的算。
 *
 * 🔴 **比 `Number()` 严**:它把 `0x10`、`0b1`、`+5`、`5.`、只有空格的串(= 0)都当成数 —— 存
 * 下去的与主人以为自己填的对不上。设置表单与新建弹窗、校验与发出去的那一格都从这里认。
 */
export function decimalOf(text: string): number | undefined {
	const trimmed = text.trim();
	if (!DECIMAL.test(trimmed)) return undefined;
	const n = Number(trimmed);
	// 写法对、却大到没边的(`1e999`)一样不收。
	return Number.isFinite(n) ? n : undefined;
}

/**
 * 当场就能说的毛病(决策 30「min / max 当场校验」)。设置表单只拿它看**改过的**格(没动过的格
 * 是存着的样子,那归服务端说);新建弹窗拿它看填了字的格。
 */
export function clientErrorOf(field: SettingsScalarField, value: Edit): string | undefined {
	if (field.type === "number") {
		const text = String(value).trim();
		if (text === "")
			return field.required
				? i18n.t("panelUi.pages.extensions.declarative.settings-form.4")
				: undefined;
		const n = decimalOf(text);
		if (n === undefined) return i18n.t("panelUi.pages.extensions.declarative.settings-form.5");
		if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
			return rangeText(field.min, field.max);
		}
		return undefined;
	}
	if (field.type === "string" && field.required && value === "")
		return i18n.t("panelUi.pages.extensions.declarative.settings-form.6");
	return undefined;
}
