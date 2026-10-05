/**
 * 会员与醒目留言的设置搬家(㉓d):0.x 里挂在 B 站名下的两个直播门槛与上舰文案,搬成「体系 + 档」的形状。接在 1.0 改名
 * ({@link renameGlobalSettingsKeys} / {@link renameSubscriptionKeys},`feature-renames.ts`)之后、直播拆键之前串着跑;
 * 全局设置与逐订阅覆盖各一个入口:
 *
 * | 0.x(改名之后的形状) | 1.0 |
 * | --- | --- |
 * | `filters.minScPrice` | `superchat.minAmount` —— 全局里旧值 0 不写(没配 = 不设门槛);逐订阅覆盖有就原样写,0 也写(它的意思是「这个订阅不设门槛」,全局可能不是 0) |
 * | `filters.minGuardLevel`(B 站 `guard_level`:1 = 总督、3 = 舰长) | `membership.minRank.guard`,rank 倒过来(1 → 3、2 → 2、3 → 1,{@link ZERO_GUARD_LEVEL_RANKS});全局里旧值 3(全推)不写;覆盖有就写,rank 1 也写 |
 * | `templates.guardBuy`(`enable` + captain / commander / governor 各一份 `{ template, imageUrl }`) | `templates.membership.guard = { enabled, default, tiers }`,见下 |
 * | 默认文案账本 `templateDefaultsSeen` 里 `guardBuy.<档>.template` / `.imageUrl` 六条 | `membership.guard.default.template` / `.imageUrl` 两条,指纹是新默认的 |
 *
 * 上舰文案的换法:`enabled` 取旧 `enable`;`default` 写出厂值({@link MEMBERSHIP_DEFAULT_TEMPLATE},空图);三档逐档、逐字段看 ——
 * 文案先做占位符改写(`{uname}` → `{viewer}`、`{mname}` → `{name}`、`{guard}` → `{tier}`,`-key` 老写法一并改成花括号写法,
 * `placeholders.ts`),**改写之后**等于该档旧默认(任何一代)改写之后的样子,就是没动过,不搬、跟随体系默认(推出去的字与
 * 今天一字不差);不等的搬进 `tiers[档].template`。图片是空串的不搬,有值的搬进 `tiers[档].imageUrl`。两格都没搬的档,`tiers`
 * 里不留这个 key;`tiers` 的键序固定是 captain / commander / governor。
 *
 * 「没动过」要认两代旧默认:全局那份文案在 0.x 那一遍里已经先过了旧默认迁移({@link migrateOldTemplateDefaults},更早一代的
 * `{user}` / `{mastername}` 写法已改成 0.x 最新的默认),到这里只可能是 0.x 最新的默认或改过的;逐订阅覆盖里的上舰文案
 * 不经那一遍,更早一代的原文会直接到这里,所以两代都认。
 *
 * 值原样搬、键序不变;认不得的形状原样放过(由配置仓开机时报出来);已经是新形状的数据再跑一遍回同一个对象,新老键并存时以新键
 * 为准、老键丢掉。**不依赖运行时代码**:档位换算与默认文案都是迁移自己冻住的一份(`zero-vocabulary.ts` 与下面的
 * {@link MEMBERSHIP_DEFAULT_TEMPLATE}),不取 internal 的档位表。
 */

import { templateFingerprint } from "@bilibili-notify/internal/template-defaults";
import { isPlainObject } from "./files.js";
import { rewritePlaceholders } from "./placeholders.js";
import { OLD_GUARD } from "./templates.js";
import {
	ZERO_DEFAULT_TEMPLATES,
	ZERO_GUARD_LEVEL_RANKS,
	ZERO_GUARD_ROLES,
	ZERO_MOVED_FILTER_KEYS,
	type ZeroGuardRole,
} from "./zero-vocabulary.js";

type Obj = Record<string, unknown>;

/**
 * 迁移写进 `templates.membership.guard.default.template` 的体系默认(1.0 首发的出厂值,冻住):推出去的字与 0.x 三档的
 * 出厂文案一字不差({tier} 填档名)。账本里新路径的指纹也按它算 —— 以后出厂默认换了,迁移上来的人账本里是这一版的指纹,
 * 规则页就会提示「默认文案有更新」,这正是账本要的。
 */
export const MEMBERSHIP_DEFAULT_TEMPLATE = "{viewer} 成为了 {name} 的{tier}！";

/** 上舰文案的占位符:0.x 的三个变量 → 1.0 的三个(键是 0.x 的,冻住)。 */
const GUARD_PLACEHOLDERS = { uname: "viewer", mname: "name", guard: "tier" } as const;

/** 这一档的文案(已做过占位符改写)是不是「没动过」:等于任何一代旧默认、做过占位符改写之后的样子。 */
function isUnchangedGuardText(role: ZeroGuardRole, rewritten: string): boolean {
	return [ZERO_DEFAULT_TEMPLATES.guardBuy[role], OLD_GUARD[role]].some(
		(old) => rewritePlaceholders(old, GUARD_PLACEHOLDERS) === rewritten,
	);
}

/** 账本里新路径的两条(顺序同 `DEFAULT_TEMPLATES` 里字符串叶子的顺序)。 */
const LEDGER_PATH_TEMPLATE = "membership.guard.default.template";
const LEDGER_PATH_IMAGE = "membership.guard.default.imageUrl";

const isGuardBuyLedgerKey = (key: string): boolean => key.startsWith("guardBuy.");

function withoutKeys(obj: Obj, keys: readonly string[]): Obj {
	return Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key)));
}

// ── 两个阈值 ────────────────────────────────────────────────────────────────────

/** 一份 `filters` 里读得懂的两个阈值:金额(≥ 0 的有限数)与 B 站的 rank(旧等级只认 1 / 2 / 3)。读不懂的当没有。 */
function thresholdsOf(filters: Obj): { minAmount?: number; guardRank?: number } {
	const price = filters.minScPrice;
	const level = filters.minGuardLevel;
	const rank = typeof level === "number" ? ZERO_GUARD_LEVEL_RANKS.get(level) : undefined;
	return {
		...(typeof price === "number" && Number.isFinite(price) && price >= 0
			? { minAmount: price }
			: {}),
		...(rank !== undefined ? { guardRank: rank } : {}),
	};
}

const hasMovedFilterKeys = (filters: Obj): boolean =>
	ZERO_MOVED_FILTER_KEYS.some((key) => Object.hasOwn(filters, key));

// ── 上舰文案 ────────────────────────────────────────────────────────────────────

/** 0.x 的一份上舰文案(`guardBuy`)→ 1.0 一个体系的文案(`membership.guard`)。 */
function toGuardBundle(guardBuy: Obj): Obj {
	const tiers: Obj = {};
	for (const role of ZERO_GUARD_ROLES) {
		const entry = guardBuy[role];
		if (!isPlainObject(entry)) continue;
		const moved: Obj = {};
		if (typeof entry.template === "string") {
			const rewritten = rewritePlaceholders(entry.template, GUARD_PLACEHOLDERS);
			if (!isUnchangedGuardText(role, rewritten)) moved.template = rewritten;
		}
		if (typeof entry.imageUrl === "string" && entry.imageUrl !== "")
			moved.imageUrl = entry.imageUrl;
		if (Object.keys(moved).length > 0) tiers[role] = moved;
	}
	return {
		enabled: guardBuy.enable === true,
		default: { template: MEMBERSHIP_DEFAULT_TEMPLATE, imageUrl: "" },
		tiers,
	};
}

/**
 * `templates`(全局与逐订阅覆盖共用):`guardBuy` 在原位换成 `membership: { guard }`。`membership` 已经在(新老并存)就以它
 * 为准、老的丢掉;`guardBuy` 不是对象的原样留着。没有要搬的回同一个对象。
 */
function moveTemplates(templates: Obj): Obj {
	if (!isPlainObject(templates.guardBuy)) return templates;
	const hasNew = Object.hasOwn(templates, "membership");
	const entries: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(templates)) {
		if (key !== "guardBuy") entries.push([key, value]);
		else if (!hasNew)
			entries.push(["membership", { guard: toGuardBundle(templates.guardBuy as Obj) }]);
	}
	return Object.fromEntries(entries);
}

/** 账本:旧的 `guardBuy.` 路径拿掉,新路径两条按新默认的指纹记成已见(已有的以已有的为准),追加在最后。 */
function moveLedger(ledger: Obj): Obj {
	const kept = Object.entries(ledger).filter(([key]) => !isGuardBuyLedgerKey(key));
	const seen: Obj = Object.fromEntries(kept);
	return {
		...seen,
		...(Object.hasOwn(seen, LEDGER_PATH_TEMPLATE)
			? {}
			: { [LEDGER_PATH_TEMPLATE]: templateFingerprint(MEMBERSHIP_DEFAULT_TEMPLATE) }),
		...(Object.hasOwn(seen, LEDGER_PATH_IMAGE)
			? {}
			: { [LEDGER_PATH_IMAGE]: templateFingerprint("") }),
	};
}

// ── 入口 ────────────────────────────────────────────────────────────────────────

/**
 * 整份全局设置(**已经改成 1.0 的键**,`feature-renames.ts` 之后)的 raw → raw:`defaults.filters` 里的两个阈值搬成
 * `defaults.superchat` / `defaults.membership`(紧跟在 `filters` 后面,没调过的不写),`defaults.templates.guardBuy` 换成
 * `membership.guard`,账本换路径。没有要搬的回同一个对象。
 */
export function moveGlobalMembership(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.defaults)) return raw;
	const defaults = raw.defaults;
	const filters = isPlainObject(defaults.filters) ? defaults.filters : undefined;
	const templates = isPlainObject(defaults.templates) ? defaults.templates : undefined;
	const ledger = isPlainObject(defaults.templateDefaultsSeen)
		? defaults.templateDefaultsSeen
		: undefined;
	const filtersMove = filters !== undefined && hasMovedFilterKeys(filters);
	const hasGuardBuy = templates !== undefined && isPlainObject(templates.guardBuy);
	const hasOldLedger = ledger !== undefined && Object.keys(ledger).some(isGuardBuyLedgerKey);
	if (!filtersMove && !hasGuardBuy && !hasOldLedger) return raw;

	// 全局里旧值是默认的(金额 0、等级 3 = rank 1)等于没设,不写。
	const { minAmount, guardRank } = filtersMove ? thresholdsOf(filters) : {};
	const superchat =
		minAmount !== undefined && minAmount > 0 && !Object.hasOwn(defaults, "superchat")
			? { minAmount }
			: undefined;
	const membership =
		guardRank !== undefined && guardRank > 1 && !Object.hasOwn(defaults, "membership")
			? { minRank: { guard: guardRank } }
			: undefined;

	const entries: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(defaults)) {
		if (key === "filters" && filters !== undefined && filtersMove) {
			entries.push([key, withoutKeys(filters, ZERO_MOVED_FILTER_KEYS)]);
			if (superchat) entries.push(["superchat", superchat]);
			if (membership) entries.push(["membership", membership]);
		} else if (key === "templates" && templates !== undefined) {
			entries.push([key, moveTemplates(templates)]);
		} else if (
			key === "templateDefaultsSeen" &&
			ledger !== undefined &&
			(hasGuardBuy || hasOldLedger)
		) {
			entries.push([key, moveLedger(ledger)]);
		} else {
			entries.push([key, value]);
		}
	}
	// 没有账本、但搬了上舰文案:建一份只有新路径两条的 —— 别的文案本来就没有账可记。
	if (hasGuardBuy && !Object.hasOwn(defaults, "templateDefaultsSeen")) {
		entries.push(["templateDefaultsSeen", moveLedger({})]);
	}
	return { ...raw, defaults: Object.fromEntries(entries) };
}

/**
 * 一条订阅(**已经改成 1.0 的键**,B 站或拓展)的 raw → raw:`overrides.filters` 里的两个阈值搬成 `overrides.superchat` /
 * `overrides.membership`(紧跟在 `filters` 后面,**有就写,0 也写**;`filters` 拿掉两个键后空了就整个删掉),
 * `overrides.templates.guardBuy` 换成 `membership.guard`。没有要搬的回同一个对象。
 */
export function moveSubscriptionMembership(row: unknown): unknown {
	if (!isPlainObject(row) || !isPlainObject(row.overrides)) return row;
	const overrides = row.overrides;
	const filters = isPlainObject(overrides.filters) ? overrides.filters : undefined;
	const templates = isPlainObject(overrides.templates) ? overrides.templates : undefined;
	const filtersMove = filters !== undefined && hasMovedFilterKeys(filters);
	const hasGuardBuy = templates !== undefined && isPlainObject(templates.guardBuy);
	if (!filtersMove && !hasGuardBuy) return row;

	const { minAmount, guardRank } = filtersMove ? thresholdsOf(filters) : {};
	const superchat =
		minAmount !== undefined && !Object.hasOwn(overrides, "superchat") ? { minAmount } : undefined;
	const membership =
		guardRank !== undefined && !Object.hasOwn(overrides, "membership")
			? { minRank: { guard: guardRank } }
			: undefined;

	const entries: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(overrides)) {
		if (key === "filters" && filters !== undefined && filtersMove) {
			const rest = withoutKeys(filters, ZERO_MOVED_FILTER_KEYS);
			if (Object.keys(rest).length > 0) entries.push([key, rest]);
			if (superchat) entries.push(["superchat", superchat]);
			if (membership) entries.push(["membership", membership]);
		} else if (key === "templates" && templates !== undefined) {
			entries.push([key, moveTemplates(templates)]);
		} else {
			entries.push([key, value]);
		}
	}
	return { ...row, overrides: Object.fromEntries(entries) };
}
