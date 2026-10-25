import { z } from "zod";
import type { Dict } from "../i18n";
import { isDictKey, malformedPlaceholders } from "../i18n";
import {
	EXTENSION_DISPLAY_LABEL_MAX_CHARS,
	EXTENSION_ITEM_LABEL_MAX_CHARS,
	EXTENSION_LOOKUP_PLACEHOLDER_MAX_CHARS,
	EXTENSION_SHORT_LABEL_MAX_CHARS,
	type ExtensionManifest,
	type ExtensionManifestField,
} from "./extension-manifest";

/**
 * 拓展译文文件（`locales/<语言码>.json`）的形状与逐条解析（3b-43；ADR-0037 决策 14
 * 下 2026-10-17 的 🔗）。
 *
 * 文件顶层是一条一条的普通译文（键 → 句子），外加一个保留段 `$manifest`：值是照清单形状
 * 嵌套的译文，设置项按 `key`、选项按 `value`、列表项的复制来源按 `host` / `field` 展开。
 * 顶层普通键与 `$manifest` 分开走：坏一条只丢那一条，别的照收 —— 整份 `safeParse` 会把
 * 一条坏键变成整份译文作废，与定案相反。
 *
 * `ExtensionLocaleFileSchema` 钉的是**全好的那份**长什么样（契约守卫用）；真正收文件时
 * 逐条过，问题进 {@link ExtensionLocaleIssue}，由宿主翻成给人看的话。
 */

/**
 * 一条译文问题的机器码 —— 核心包没有字典，给人看的话归宿主（3b-43 提交 4）出。
 *
 * 命名规范表里的「校验不过的一条原因」叫 `Issue`，形状是 `{ path?, message }`；这里不能
 * 直接用它：`message` 是给人看的句子，而核心包没有字典，写中文会涨「写死的中文」那道
 * 棘轮、写英文又轮到宿主翻不了。所以形状只带 `code`，宿主按码出字。
 */
export type ExtensionLocaleIssueCode =
	/** 普通键不满足 BN 的段形（含会碰原型链的段）。 */
	| "invalid-key"
	/** 该是字符串的地方不是非空串（整层不是对象也走这条）。 */
	| "invalid-text"
	/** 句子里的花括号不是 `{名字}`。 */
	| "malformed-placeholder"
	/** 清单里没有这个 key / value / host。 */
	| "unknown-entry"
	/** 清单里有这一格，但它不是给人看的字（`color` / `id` 这类）。 */
	| "untranslatable-entry"
	/** 超过清单那一格自己的长度上限。 */
	| "too-long";

export interface ExtensionLocaleIssue {
	/** 从译文文件根起算；`$manifest` 下的路径照清单里的键写，不进数组下标。 */
	path: (string | number)[];
	code: ExtensionLocaleIssueCode;
}

const LocaleTextSchema = z.string().min(1);
const DisplayLabelSchema = LocaleTextSchema.max(EXTENSION_DISPLAY_LABEL_MAX_CHARS);
const ShortLabelSchema = LocaleTextSchema.max(EXTENSION_SHORT_LABEL_MAX_CHARS);
const ItemLabelSchema = LocaleTextSchema.max(EXTENSION_ITEM_LABEL_MAX_CHARS);
const LookupPlaceholderSchema = LocaleTextSchema.max(EXTENSION_LOOKUP_PLACEHOLDER_MAX_CHARS);
// 清单里这几格本身允许空串（`z.string().optional()`）：译文清空它们是有意义的事，
// 不该当成坏条目丢掉。
const OptionalTextSchema = z.string();

const LabelEntrySchema = z.strictObject({ label: LocaleTextSchema.optional() });

const ScalarFieldTranslationSchema = z.strictObject({
	label: LocaleTextSchema.optional(),
	description: OptionalTextSchema.optional(),
	placeholder: OptionalTextSchema.optional(),
	unit: OptionalTextSchema.optional(),
	options: z.record(z.string(), LabelEntrySchema).optional(),
});

const ListFieldTranslationSchema = z.strictObject({
	label: LocaleTextSchema.optional(),
	description: OptionalTextSchema.optional(),
	itemLabel: ItemLabelSchema.optional(),
	removeWarning: LocaleTextSchema.optional(),
	fields: z.record(z.string(), ScalarFieldTranslationSchema).optional(),
	newItemCopy: z.record(z.string(), LabelEntrySchema).optional(),
});

const FieldTranslationSchema = z.union([ScalarFieldTranslationSchema, ListFieldTranslationSchema]);

const ManifestTranslationSchema = z.strictObject({
	name: LocaleTextSchema.optional(),
	description: LocaleTextSchema.optional(),
	settings: z
		.strictObject({
			fields: z.record(z.string(), FieldTranslationSchema).optional(),
		})
		.optional(),
	contributes: z
		.strictObject({
			push: z
				.strictObject({
					label: DisplayLabelSchema.optional(),
					shortLabel: ShortLabelSchema.optional(),
					settingsFields: z.record(z.string(), ScalarFieldTranslationSchema).optional(),
				})
				.optional(),
			subscription: z
				.strictObject({
					label: DisplayLabelSchema.optional(),
					shortLabel: ShortLabelSchema.optional(),
					postNoun: ShortLabelSchema.optional(),
					externalIdNoun: ShortLabelSchema.optional(),
					lookupPlaceholder: LookupPlaceholderSchema.optional(),
				})
				.optional(),
		})
		.optional(),
});

/** 译文文件**全好**时的形状；契约守卫钉这一份。 */
export const ExtensionLocaleFileSchema = z
	.object({ $manifest: ManifestTranslationSchema.optional() })
	.catchall(LocaleTextSchema);

/** 译文文件里 `$manifest` 那一层（只有有效的清单格子）。 */
export type ExtensionLocaleManifest = z.infer<typeof ManifestTranslationSchema>;

/** 一份译文文件逐条解析后的结果。 */
export interface ExtensionLocaleFile {
	/** 运行时那层：键 → 句子。 */
	dict: Dict;
	/** 清单那层：照清单形状嵌套，只有有效的格子。 */
	manifest: ExtensionLocaleManifest;
	/** 丢掉的那几条与原因；没有就是空数组。 */
	issues: ExtensionLocaleIssue[];
}

type Path = (string | number)[];

interface LabelTranslation {
	label?: string;
}

interface FieldTranslation {
	label?: string;
	description?: string;
	placeholder?: string;
	unit?: string;
	options?: Record<string, LabelTranslation>;
	itemLabel?: string;
	removeWarning?: string;
	fields?: Record<string, FieldTranslation>;
	newItemCopy?: Record<string, LabelTranslation>;
}

interface DisplayTranslation {
	label?: string;
	shortLabel?: string;
	postNoun?: string;
	externalIdNoun?: string;
	lookupPlaceholder?: string;
}

interface PushTranslation extends DisplayTranslation {
	settingsFields?: Record<string, FieldTranslation>;
}

interface ManifestTranslation {
	name?: string;
	description?: string;
	settings?: { fields?: Record<string, FieldTranslation> };
	contributes?: {
		push?: PushTranslation;
		subscription?: DisplayTranslation;
	};
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 不用 `target[key] = value`：JSON.parse 出来的键可以是 `__proto__`，赋值会走原型 setter。 */
function put(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function nonEmptyObject(record: object): boolean {
	return Object.keys(record).length > 0;
}

/** 取一格字；不在就跳过，坏的记一条问题并跳过。 */
function textOf(
	source: Record<string, unknown>,
	key: string,
	path: Path,
	issues: ExtensionLocaleIssue[],
	limits: { min?: number; max?: number; nonBlank?: boolean } = {},
): string | undefined {
	const { min = 1, max, nonBlank = false } = limits;
	if (!Object.hasOwn(source, key)) return undefined;
	const value = source[key];
	if (typeof value !== "string" || value.length < min) {
		issues.push({ path: [...path, key], code: "invalid-text" });
		return undefined;
	}
	if (nonBlank && value.trim() === "") {
		issues.push({ path: [...path, key], code: "invalid-text" });
		return undefined;
	}
	if (max !== undefined && value.length > max) {
		issues.push({ path: [...path, key], code: "too-long" });
		return undefined;
	}
	return value;
}

/**
 * 只有一个 `label` 可译的一格（枚举选项、`newItemCopy` 的 host 项）。
 * `untranslatable` 是这一格里清单有、但不给人看的键（`value` / `icon` / `host`）。
 */
function labelEntryOf(
	source: unknown,
	path: Path,
	issues: ExtensionLocaleIssue[],
	untranslatable: ReadonlySet<string> = EMPTY_KEYS,
): LabelTranslation | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: LabelTranslation = {};
	for (const key of Object.keys(source)) {
		if (key === "label") {
			const label = textOf(source, key, path, issues);
			if (label !== undefined) out.label = label;
		} else if (untranslatable.has(key)) {
			issues.push({ path: [...path, key], code: "untranslatable-entry" });
		} else {
			issues.push({ path: [...path, key], code: "unknown-entry" });
		}
	}
	return out.label === undefined ? undefined : out;
}

/** 一组按清单里的 key / value / host 展开的 label 项。 */
function labelRecordOf(
	source: unknown,
	path: Path,
	issues: ExtensionLocaleIssue[],
	knownKeys: ReadonlySet<string>,
	untranslatableKeys: ReadonlySet<string> = EMPTY_KEYS,
	entryUntranslatable: ReadonlySet<string> = EMPTY_KEYS,
): Record<string, LabelTranslation> | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: Record<string, LabelTranslation> = {};
	for (const [key, value] of Object.entries(source)) {
		const here = [...path, key];
		if (untranslatableKeys.has(key)) {
			issues.push({ path: here, code: "untranslatable-entry" });
			continue;
		}
		if (!knownKeys.has(key)) {
			issues.push({ path: here, code: "unknown-entry" });
			continue;
		}
		const entry = labelEntryOf(value, here, issues, entryUntranslatable);
		if (entry !== undefined) put(out, key, entry);
	}
	return nonEmptyObject(out) ? out : undefined;
}

function optionsOf(
	source: unknown,
	options: readonly { value: string }[] | undefined,
	path: Path,
	issues: ExtensionLocaleIssue[],
): Record<string, LabelTranslation> | undefined {
	const known = new Set((options ?? []).map((option) => option.value));
	return labelRecordOf(source, path, issues, known, EMPTY_KEYS, new Set(["value", "icon"]));
}

function newItemCopyOf(
	source: unknown,
	entries: readonly ({ field: string } | { host: string })[] | undefined,
	path: Path,
	issues: ExtensionLocaleIssue[],
): Record<string, LabelTranslation> | undefined {
	const hosts = new Set<string>();
	const fields = new Set<string>();
	for (const entry of entries ?? []) {
		if ("host" in entry) hosts.add(entry.host);
		else fields.add(entry.field);
	}
	return labelRecordOf(source, path, issues, hosts, fields, new Set(["host"]));
}

function fieldsOf(
	source: unknown,
	fields: readonly ExtensionManifestField[],
	path: Path,
	issues: ExtensionLocaleIssue[],
): Record<string, FieldTranslation> | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const byKey = new Map(fields.map((field) => [field.key, field]));
	const out: Record<string, FieldTranslation> = {};
	for (const [key, value] of Object.entries(source)) {
		const here = [...path, key];
		const field = byKey.get(key);
		if (field === undefined) {
			issues.push({ path: here, code: "unknown-entry" });
			continue;
		}
		const translation = fieldOf(value, field, here, issues);
		if (translation !== undefined) put(out, key, translation);
	}
	return nonEmptyObject(out) ? out : undefined;
}

function fieldOf(
	source: unknown,
	field: ExtensionManifestField,
	path: Path,
	issues: ExtensionLocaleIssue[],
): FieldTranslation | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}

	const translatable = new Set(["label", "description"]);
	const untranslatable = new Set(["key", "type", "required"]);
	switch (field.type) {
		case "string":
			translatable.add("placeholder");
			for (const key of ["default", "secret", "multiline", "monospace", "generate"]) {
				untranslatable.add(key);
			}
			break;
		case "number":
			translatable.add("unit");
			for (const key of ["default", "min", "max", "step"]) untranslatable.add(key);
			break;
		case "boolean":
			untranslatable.add("default");
			break;
		case "enum":
			translatable.add("options");
			untranslatable.add("default");
			break;
		case "list":
			for (const key of ["itemLabel", "removeWarning", "fields", "newItemCopy"]) {
				translatable.add(key);
			}
			for (const key of ["title", "mark", "toggle"]) untranslatable.add(key);
			break;
	}

	const out: FieldTranslation = {};
	for (const key of Object.keys(source)) {
		const here = [...path, key];
		if (!translatable.has(key)) {
			issues.push({
				path: here,
				code: untranslatable.has(key) ? "untranslatable-entry" : "unknown-entry",
			});
			continue;
		}
		if (key === "options" && field.type === "enum") {
			const options = optionsOf(source[key], field.options, here, issues);
			if (options !== undefined) out.options = options;
			continue;
		}
		if (key === "fields" && field.type === "list") {
			const fields = fieldsOf(source[key], field.fields, here, issues);
			if (fields !== undefined) out.fields = fields;
			continue;
		}
		if (key === "newItemCopy" && field.type === "list") {
			const copy = newItemCopyOf(source[key], field.newItemCopy, here, issues);
			if (copy !== undefined) out.newItemCopy = copy;
			continue;
		}
		const optional = key === "description" || key === "placeholder" || key === "unit";
		const max = key === "itemLabel" ? EXTENSION_ITEM_LABEL_MAX_CHARS : undefined;
		const text = textOf(source, key, path, issues, { min: optional ? 0 : 1, max });
		if (text !== undefined) put(out, key, text);
	}
	return nonEmptyObject(out) ? out : undefined;
}

/** 两口外观里给人看的几格:推送口只有名字两格,订阅口多三格叫法与提示。 */
const PUSH_TEXT_KEYS: ReadonlySet<string> = new Set(["label", "shortLabel"]);
const SUBSCRIPTION_TEXT_KEYS: ReadonlySet<string> = new Set([
	...PUSH_TEXT_KEYS,
	"postNoun",
	"externalIdNoun",
	"lookupPlaceholder",
]);

/** 外观里一格给人看的字:长度上限照清单那一侧,叫法那两格纯空白也拒(同一把尺子)。 */
function putDisplayText(
	out: object,
	source: Record<string, unknown>,
	key: string,
	path: Path,
	issues: ExtensionLocaleIssue[],
): void {
	const max =
		key === "label"
			? EXTENSION_DISPLAY_LABEL_MAX_CHARS
			: key === "lookupPlaceholder"
				? EXTENSION_LOOKUP_PLACEHOLDER_MAX_CHARS
				: EXTENSION_SHORT_LABEL_MAX_CHARS;
	const text = textOf(source, key, path, issues, {
		max,
		nonBlank: key === "postNoun" || key === "externalIdNoun",
	});
	if (text !== undefined) put(out, key, text);
}

function pushOf(
	source: unknown,
	manifest: ExtensionManifest,
	path: Path,
	issues: ExtensionLocaleIssue[],
): NonNullable<NonNullable<ManifestTranslation["contributes"]>["push"]> | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: NonNullable<NonNullable<ManifestTranslation["contributes"]>["push"]> = {};
	for (const key of Object.keys(source)) {
		const here = [...path, key];
		if (PUSH_TEXT_KEYS.has(key)) {
			putDisplayText(out, source, key, path, issues);
		} else if (key === "settingsFields") {
			const fields = fieldsOf(
				source[key],
				manifest.contributes.push?.settingsFields ?? [],
				here,
				issues,
			);
			if (fields !== undefined) out.settingsFields = fields;
		} else if (key === "color") {
			issues.push({ path: here, code: "untranslatable-entry" });
		} else {
			issues.push({ path: here, code: "unknown-entry" });
		}
	}
	return nonEmptyObject(out) ? out : undefined;
}

function subscriptionOf(
	source: unknown,
	path: Path,
	issues: ExtensionLocaleIssue[],
): NonNullable<NonNullable<ManifestTranslation["contributes"]>["subscription"]> | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: NonNullable<NonNullable<ManifestTranslation["contributes"]>["subscription"]> = {};
	for (const key of Object.keys(source)) {
		const here = [...path, key];
		if (SUBSCRIPTION_TEXT_KEYS.has(key)) {
			putDisplayText(out, source, key, path, issues);
		} else if (
			key === "color" ||
			key === "externalIdRegex" ||
			key === "supportedFeatures" ||
			key === "cardSkin"
		) {
			issues.push({ path: here, code: "untranslatable-entry" });
		} else {
			issues.push({ path: here, code: "unknown-entry" });
		}
	}
	return nonEmptyObject(out) ? out : undefined;
}

function settingsOf(
	source: unknown,
	manifest: ExtensionManifest,
	path: Path,
	issues: ExtensionLocaleIssue[],
): { fields?: Record<string, FieldTranslation> } | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: { fields?: Record<string, FieldTranslation> } = {};
	for (const key of Object.keys(source)) {
		if (key !== "fields") {
			issues.push({ path: [...path, key], code: "unknown-entry" });
			continue;
		}
		const fields = fieldsOf(source[key], manifest.settings?.fields ?? [], [...path, key], issues);
		if (fields !== undefined) out.fields = fields;
	}
	return out.fields === undefined ? undefined : out;
}

function contributesOf(
	source: unknown,
	manifest: ExtensionManifest,
	path: Path,
	issues: ExtensionLocaleIssue[],
): NonNullable<ManifestTranslation["contributes"]> | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: NonNullable<ManifestTranslation["contributes"]> = {};
	for (const key of Object.keys(source)) {
		const here = [...path, key];
		if (key === "push") {
			if (manifest.contributes.push === undefined) {
				issues.push({ path: here, code: "unknown-entry" });
				continue;
			}
			const push = pushOf(source[key], manifest, here, issues);
			if (push !== undefined) out.push = push;
		} else if (key === "subscription") {
			if (manifest.contributes.subscription === undefined) {
				issues.push({ path: here, code: "unknown-entry" });
				continue;
			}
			const subscription = subscriptionOf(source[key], here, issues);
			if (subscription !== undefined) out.subscription = subscription;
		} else {
			issues.push({ path: here, code: "unknown-entry" });
		}
	}
	return nonEmptyObject(out) ? out : undefined;
}

const MANIFEST_UNTRANSLATABLE = new Set([
	"$schema",
	"id",
	"version",
	"apiVersion",
	"apiRevision",
	"icon",
	"actions",
]);

function manifestOf(
	source: unknown,
	manifest: ExtensionManifest,
	path: Path,
	issues: ExtensionLocaleIssue[],
): ManifestTranslation | undefined {
	if (!isRecord(source)) {
		issues.push({ path, code: "invalid-text" });
		return undefined;
	}
	const out: ManifestTranslation = {};
	for (const key of Object.keys(source)) {
		const here = [...path, key];
		if (key === "name" || key === "description") {
			const text = textOf(source, key, path, issues);
			if (text !== undefined) put(out, key, text);
			continue;
		}
		if (key === "settings") {
			if (manifest.settings === undefined) {
				issues.push({ path: here, code: "unknown-entry" });
				continue;
			}
			const settings = settingsOf(source[key], manifest, here, issues);
			if (settings !== undefined) out.settings = settings;
			continue;
		}
		if (key === "contributes") {
			const contributes = contributesOf(source[key], manifest, here, issues);
			if (contributes !== undefined) out.contributes = contributes;
			continue;
		}
		issues.push({
			path: here,
			code: MANIFEST_UNTRANSLATABLE.has(key) ? "untranslatable-entry" : "unknown-entry",
		});
	}
	return nonEmptyObject(out) ? out : undefined;
}

/**
 * 逐条收下一份已 `JSON.parse` 的译文：合法的进结果，不合法的丢掉并记一条问题。
 *
 * 运行时那层与清单那层互不牵连：`$manifest` 写坏不影响普通译文，某一条普通译文写坏也不
 * 影响清单字段。`manifest` 只用来判断清单里有没有那一格、以及那一格自己的上限。
 */
export function parseExtensionLocaleFile(
	raw: unknown,
	manifest: ExtensionManifest,
): ExtensionLocaleFile {
	if (!isRecord(raw)) {
		return {
			dict: {},
			manifest: {},
			issues: [{ path: [], code: "invalid-text" }],
		};
	}

	const issues: ExtensionLocaleIssue[] = [];
	const dict = new Map<string, string>();
	const translated: ManifestTranslation = {};

	for (const [key, value] of Object.entries(raw)) {
		if (key === "$manifest") {
			const parsed = manifestOf(value, manifest, ["$manifest"], issues);
			for (const [manifestKey, manifestValue] of Object.entries(parsed ?? {})) {
				put(translated, manifestKey, manifestValue);
			}
			continue;
		}
		if (!isDictKey(key)) {
			issues.push({ path: [key], code: "invalid-key" });
			continue;
		}
		if (typeof value !== "string" || value.length === 0) {
			issues.push({ path: [key], code: "invalid-text" });
			continue;
		}
		if (malformedPlaceholders(value).length > 0) {
			issues.push({ path: [key], code: "malformed-placeholder" });
			continue;
		}
		dict.set(key, value);
	}

	return {
		dict: Object.fromEntries(dict),
		manifest: translated as ExtensionLocaleManifest,
		issues,
	};
}
