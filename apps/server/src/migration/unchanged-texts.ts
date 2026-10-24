/**
 * 0.x 里仍是出厂默认的文字模板不搬进 1.0:没有这一格,读取时按当前语言取出厂文案(ADR-0037 决策 10)。
 *
 * 只拿**冻住的 0.12 默认**比,不读运行时的出厂文案:0.x 里主人手写成恰好等于 1.0 当前默认的句子仍是他明确写下的,
 * 要照存。历代旧默认在前面的流水里都已被改写成 0.12 的句子,所以这里只比一组。
 *
 * 接在会员搬家与文案键改名、直播占位符改写之后;全局设置里 `templatesSeen` 已经上提到顶层。账本只在文字还存着时
 * 有意义,所以这里同时修剪已经不存在、停用词与图片的条目。订阅没有账本,只处理会员体系默认那一格。
 */

import { isPlainObject } from "./files.js";
import { OLD_DEFAULTS, rewriteText } from "./live-placeholders.js";
import { MEMBERSHIP_DEFAULT_TEMPLATE } from "./membership-moves.js";
import { ZERO_DEFAULT_TEMPLATES } from "./zero-vocabulary.js";

type Obj = Record<string, unknown>;

function rewrittenOldDefault(key: keyof typeof OLD_DEFAULTS): string {
	const old = OLD_DEFAULTS[key]?.[0];
	if (old === undefined) throw new Error("missing frozen live text default");
	return rewriteText(key, old);
}

/** 0.12 默认走完今天的改名、直播占位符改写之后,流水末尾看到的八条文字。 */
const UNCHANGED_GLOBAL_TEXTS = {
	liveStart: ZERO_DEFAULT_TEMPLATES.liveStart,
	liveStreaming: ZERO_DEFAULT_TEMPLATES.liveOngoing,
	liveEnd: ZERO_DEFAULT_TEMPLATES.liveEnd,
	liveSummary: rewrittenOldDefault("liveSummary"),
	post: ZERO_DEFAULT_TEMPLATES.dynamic,
	postVideo: ZERO_DEFAULT_TEMPLATES.dynamicVideo,
	viewerChat: rewrittenOldDefault("viewerChat"),
	viewerEnter: rewrittenOldDefault("viewerEnter"),
} as const;

const UNCHANGED_GLOBAL_TEXT_KEYS = Object.keys(UNCHANGED_GLOBAL_TEXTS);

/** 会员体系里，默认那一格等于迁移写下的冻住默认就删；开关、图片与档位不动。 */
function withoutMembershipDefaultTemplate(bundle: Obj): Obj {
	if (!isPlainObject(bundle.default) || bundle.default.template !== MEMBERSHIP_DEFAULT_TEMPLATE) {
		return bundle;
	}
	const { template: _template, ...defaultRest } = bundle.default;
	return { ...bundle, default: defaultRest };
}

/** 一份 `templates.membership`(体系 key → 体系文案包)里删掉等于冻住默认的 `default.template`。 */
function withoutMembershipDefaultTemplates(membership: Obj): Obj {
	let changed = false;
	const next: Obj = {};
	for (const [program, bundle] of Object.entries(membership)) {
		const rewritten = isPlainObject(bundle) ? withoutMembershipDefaultTemplate(bundle) : bundle;
		if (rewritten !== bundle) changed = true;
		next[program] = rewritten;
	}
	return changed ? next : membership;
}

/** 全局 `defaults.templates`:八条等于 0.12 默认的文字删键,会员体系默认那一格删掉。 */
function withoutUnchangedTemplates(templates: Obj): Obj {
	let changed = false;
	const next: Obj = {};
	for (const [key, value] of Object.entries(templates)) {
		if (
			UNCHANGED_GLOBAL_TEXT_KEYS.includes(key) &&
			value === UNCHANGED_GLOBAL_TEXTS[key as keyof typeof UNCHANGED_GLOBAL_TEXTS]
		) {
			changed = true;
			continue;
		}
		if (key === "membership" && isPlainObject(value)) {
			const membership = withoutMembershipDefaultTemplates(value);
			if (membership !== value) changed = true;
			next[key] = membership;
			continue;
		}
		next[key] = value;
	}
	return changed ? next : templates;
}

/** 点路径在模板里仍指着一条字符串:账本只给这样的文字留着。 */
function textAtPath(templates: Obj, path: string): string | undefined {
	let value: unknown = templates;
	for (const segment of path.split(".")) {
		if (!isPlainObject(value) || !Object.hasOwn(value, segment)) return undefined;
		value = value[segment];
	}
	return typeof value === "string" ? value : undefined;
}

/** 账本只留仍有文字存着的点路径;停用词与图片不是文字模板,不记账。 */
function withoutNonTextLedgerEntries(ledger: Obj, templates: Obj): Obj {
	const kept = Object.entries(ledger).filter(
		([path]) =>
			path !== "wordcloudStopWords" &&
			!path.endsWith(".imageUrl") &&
			textAtPath(templates, path) !== undefined,
	);
	return kept.length === Object.keys(ledger).length ? ledger : Object.fromEntries(kept);
}

/**
 * 整份全局设置(已改成 1.0 形状、账本已上提)→ raw:拿掉没改过的文字与会员体系默认,修剪账本;缺 `locale` 时写
 * 简体。认不得的形状原样放过;没有要改的回同一个对象。
 */
export function removeUnchangedGlobalTexts(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	let out = raw;
	const defaults = isPlainObject(raw.defaults) ? raw.defaults : undefined;
	const templates = defaults && isPlainObject(defaults.templates) ? defaults.templates : undefined;
	const nextTemplates = templates && withoutUnchangedTemplates(templates);
	if (templates !== undefined && nextTemplates !== templates) {
		out = { ...out, defaults: { ...defaults, templates: nextTemplates } };
	}

	const ledger = isPlainObject(raw.templatesSeen) ? raw.templatesSeen : undefined;
	if (ledger !== undefined) {
		const ledgerTemplates = nextTemplates ?? templates;
		if (ledgerTemplates !== undefined) {
			const nextLedger = withoutNonTextLedgerEntries(ledger, ledgerTemplates);
			if (nextLedger !== ledger) out = { ...out, templatesSeen: nextLedger };
		}
	}

	if (!Object.hasOwn(out, "locale")) out = { ...out, locale: "zh-CN" };
	return out;
}

/**
 * 一条订阅(已改成 1.0 形状)→ raw:会员体系覆盖里 `default.template` 等于迁移写下的冻住默认的那一格删掉;
 * 别的文字覆盖、开关、图片与档位原样。没有要改的回同一个对象。
 */
export function removeUnchangedSubscriptionTexts(row: unknown): unknown {
	if (!isPlainObject(row) || !isPlainObject(row.overrides)) return row;
	const overrides = row.overrides;
	if (!isPlainObject(overrides.templates)) return row;
	const templates = overrides.templates;
	if (!isPlainObject(templates.membership)) return row;
	const membership = withoutMembershipDefaultTemplates(templates.membership);
	if (membership === templates.membership) return row;
	return {
		...row,
		overrides: { ...overrides, templates: { ...templates, membership } },
	};
}
