import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type ExtensionLocaleFile,
	type ExtensionLocaleIssueCode,
	type ExtensionManifest,
	parseExtensionLocaleFile,
	type SettingsField,
} from "@bilibili-notify/internal";
import { type Dict, LOCALES, type Locale, mergeDict } from "@bilibili-notify/internal/i18n";

/** 拓展译文目录(ADR-0037 决策 14):一种语言一个 `<语言码>.json`,不认别的名字。 */
export const EXTENSION_LOCALES_DIR = "locales";
/**
 * 一份译文的上限。译文是纯字符串表,256 KB 已经是几万句;再大多半是打错了。
 *
 * 打包那头同样各写一份数,`pack-extension.test.mjs` 拿两头对着钉。
 */
export const EXTENSION_LOCALE_FILE_MAX_BYTES = 256 * 1024;
/** `locales/` 整个目录的上限。单份各合规、合起来过大一样拦。 */
export const EXTENSION_LOCALES_TOTAL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 拓展包里的译文(ADR-0037 决策 14;格式见 `docs/1.0/extension-contract.md`「译文与 `ctx.i18n`」)。
 *
 * 宿主在**读目录**那一步把 `locales/` 一次读好、逐条过一遍,之后只在内存里按当前语言合与盖:
 * 语言整台一种、出字那一刻读(决策 1),所以盖清单是列表现取时做的、不是读目录那一刻定死。
 * 这里不碰核心 `createI18n` 的 `fallback`:回落链是宿主先合成每种语言的一份平实版再交出去。
 */

/**
 * 一条没收下的译文的原因。形状**不是**命名规范里那个 `Issue`(`{ path?, message }`):
 * `message` 是给人看的句子,而句子要等到出字那一刻按当前语言取,所以这里只存「哪个语言文件、
 * 哪一条、为什么的码」,路由那一层再翻成话。
 */
export interface LocaleIssue {
	/** 哪一份文件(`locales/<locale>.json`)。 */
	locale: Locale;
	code: LocaleIssueCode;
	/** 从文件根起算的路径;整份丢掉的(`invalid-json` / `too-large`)是空数组。 */
	path: (string | number)[];
}

/** 核心逐条解析给的码,外加宿主读文件这一步才有的两种整份丢。 */
export type LocaleIssueCode = ExtensionLocaleIssueCode | "invalid-json" | "too-large";

/** 一个拓展目录里读好的全部译文。 */
export interface ExtensionLocales {
	/** 读得进来的语言 → 逐条解析后的那一份。键只会是语言表里的。 */
	files: Partial<Record<Locale, ExtensionLocaleFile>>;
	issues: LocaleIssue[];
}

/**
 * 回落链,**从高到低**:本语言 → 简中 → 英文(R1 乙,固定、不按语言分)。清单字段最后再落清单原字,
 * 运行时取字走到链尾仍没有就由 `translate` 回键本身。
 */
function chainOf(locale: string): readonly string[] {
	return [...new Set([locale, "zh-CN", "en"])];
}

function fileOf(locales: ExtensionLocales, locale: string): ExtensionLocaleFile | undefined {
	return Object.hasOwn(locales.files, locale) ? locales.files[locale as Locale] : undefined;
}

/**
 * 读 `<dir>/locales/` 里语言表中的 `<语言码>.json`。
 *
 * 文件名取自 `LOCALES`、不 `readdir`:不在表里的(`ko.json`、`notes.txt`)根本不看。不是 JSON 的、
 * 超单份上限的整份丢并记一条;读不到(没有这份)不算问题。总量上限只有装包那一道管 —— 四种语言
 * 各到单份上限也到不了它。
 */
export async function readExtensionLocales(
	dir: string,
	manifest: ExtensionManifest,
): Promise<ExtensionLocales> {
	const files: Partial<Record<Locale, ExtensionLocaleFile>> = {};
	const issues: LocaleIssue[] = [];
	for (const locale of LOCALES) {
		const path = join(dir, EXTENSION_LOCALES_DIR, `${locale}.json`);
		let size: number;
		try {
			const info = await stat(path);
			if (!info.isFile()) continue;
			size = info.size;
		} catch {
			continue;
		}
		if (size > EXTENSION_LOCALE_FILE_MAX_BYTES) {
			issues.push({ locale, code: "too-large", path: [] });
			continue;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch (err) {
			// 读到一半被换掉也算「这一份读不了」,但只有 JSON 解析错才说是坏 JSON。
			if (err instanceof SyntaxError) issues.push({ locale, code: "invalid-json", path: [] });
			continue;
		}
		const parsed = parseExtensionLocaleFile(raw, manifest);
		files[locale] = parsed;
		for (const issue of parsed.issues) {
			issues.push({ locale, code: issue.code, path: issue.path });
		}
	}
	return { files, issues };
}

/**
 * 某种语言下的运行时译文:链上三份从低到高叠成一份平实版。核心的 `mergeDict` 按「句」覆盖,
 * 所以本语言缺哪一句,只那一句落到简中 / 英文。
 */
export function runtimeDictOf(locales: ExtensionLocales, locale: string): Dict {
	const low = [...chainOf(locale)].reverse();
	return mergeDict(...low.map((name) => fileOf(locales, name)?.dict));
}

// ---- 盖清单 -----------------------------------------------------------------------

/** 译文那一层里一格设置项的样子(标量与列表的并集,没有的格就是 `undefined`)。 */
interface FieldTranslation {
	label?: string;
	description?: string;
	placeholder?: string;
	unit?: string;
	options?: Record<string, { label?: string }>;
	itemLabel?: string;
	removeWarning?: string;
	fields?: Record<string, FieldTranslation>;
	newItemCopy?: Record<string, { label?: string }>;
}

/** 链上各层里同一格的译文,从高到低;这一层没有这一格就是 `undefined`。 */
type Layers<T> = readonly (T | undefined)[];

/** 只认自有键:选项的 `value` 是任意字符串,`__proto__` 之类顺着原型链会取到东西。 */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
	return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** 从高到低找第一个有的。 */
function pick<T, R>(layers: Layers<T>, get: (layer: T) => R | undefined): R | undefined {
	for (const layer of layers) {
		if (layer === undefined) continue;
		const value = get(layer);
		if (value !== undefined) return value;
	}
	return undefined;
}

function localizeField<F extends SettingsField>(field: F, layers: Layers<FieldTranslation>): F {
	const out: Record<string, unknown> = { ...field };
	const label = pick(layers, (layer) => layer.label);
	if (label !== undefined) out.label = label;
	const description = pick(layers, (layer) => layer.description);
	if (description !== undefined) out.description = description;
	switch (field.type) {
		case "string": {
			const placeholder = pick(layers, (layer) => layer.placeholder);
			if (placeholder !== undefined) out.placeholder = placeholder;
			break;
		}
		case "number": {
			const unit = pick(layers, (layer) => layer.unit);
			if (unit !== undefined) out.unit = unit;
			break;
		}
		case "enum":
			out.options = field.options.map((option) => ({
				...option,
				label: pick(layers, (layer) => own(layer.options, option.value)?.label) ?? option.label,
			}));
			break;
		case "list": {
			const itemLabel = pick(layers, (layer) => layer.itemLabel);
			if (itemLabel !== undefined) out.itemLabel = itemLabel;
			const removeWarning = pick(layers, (layer) => layer.removeWarning);
			if (removeWarning !== undefined) out.removeWarning = removeWarning;
			out.fields = field.fields.map((child) =>
				localizeField(
					child,
					layers.map((layer) => own(layer?.fields, child.key)),
				),
			);
			if (field.newItemCopy !== undefined) {
				out.newItemCopy = field.newItemCopy.map((entry) =>
					"host" in entry
						? {
								...entry,
								label:
									pick(layers, (layer) => own(layer.newItemCopy, entry.host)?.label) ?? entry.label,
							}
						: entry,
				);
			}
			break;
		}
		default:
			break;
	}
	return out as F;
}

function localizeFields<F extends SettingsField>(
	fields: readonly F[],
	layers: Layers<Record<string, FieldTranslation>>,
): F[] {
	return fields.map((field) =>
		localizeField(
			field,
			layers.map((layer) => own(layer, field.key)),
		),
	);
}

/** 外观里给人看的六格(推送口只有前两格)。 */
interface DisplayTranslation {
	label?: string;
	shortLabel?: string;
	postNoun?: string;
	creatorNoun?: string;
	externalIdNoun?: string;
}

const DISPLAY_TEXT_KEYS = [
	"label",
	"shortLabel",
	"postNoun",
	"creatorNoun",
	"externalIdNoun",
] as const;

/** 外观里几格给人看的字:链上有就用,没有留原字(原清单没写的可选格,译文给了也一并盖上)。 */
function localizeDisplay<D extends { label: string }>(
	display: D,
	layers: Layers<DisplayTranslation>,
): D {
	const out: Record<string, unknown> = { ...display };
	for (const key of DISPLAY_TEXT_KEYS) {
		const text = pick(layers, (layer) => layer[key]);
		if (text !== undefined) out[key] = text;
	}
	return out as D;
}

/**
 * 按当前语言盖清单里给人看的字,回一份新的清单(原清单不动)。回落链:本语言 → 简中 → 英文 →
 * 清单原字。译文已经在读文件那一步逐条核过(对得上清单才收),这里只管按路径取。
 */
export function localizeManifest(
	manifest: ExtensionManifest,
	locales: ExtensionLocales,
	locale: string,
): ExtensionManifest {
	const layers = chainOf(locale).flatMap((name) => {
		const translation = fileOf(locales, name)?.manifest;
		return translation === undefined ? [] : [translation];
	});
	if (layers.length === 0) return manifest;

	const settings = manifest.settings
		? {
				...manifest.settings,
				fields: localizeFields(
					manifest.settings.fields,
					layers.map((layer) => layer.settings?.fields),
				),
			}
		: undefined;

	const { push, subscription } = manifest.contributes;
	const contributes = {
		...manifest.contributes,
		...(push
			? {
					push: {
						...localizeDisplay(
							push,
							layers.map((layer) => layer.contributes?.push),
						),
						...(push.settingsFields
							? {
									settingsFields: localizeFields(
										push.settingsFields,
										layers.map((layer) => layer.contributes?.push?.settingsFields),
									),
								}
							: {}),
					},
				}
			: {}),
		...(subscription
			? {
					subscription: {
						...localizeDisplay(
							subscription,
							layers.map((layer) => layer.contributes?.subscription),
						),
					},
				}
			: {}),
	};

	return {
		...manifest,
		name: pick(layers, (layer) => layer.name) ?? manifest.name,
		description: pick(layers, (layer) => layer.description) ?? manifest.description,
		...(settings ? { settings } : {}),
		contributes,
	};
}
