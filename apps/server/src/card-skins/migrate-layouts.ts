/**
 * **开机一次性迁移:旧版式 `cardLayout` → 卡片皮肤**(ADR-0014 决策 15 / 17)。
 *
 * 折叠本身归 `cardLayoutToSkin`(packages/internal),这里只管「谁该折、折出来的皮肤归谁、
 * 折完把旧键收拾干净」这三件事:
 *
 * 1. 全局版式与出厂默认不同 → 折一套「自定义(迁移自旧版式)」,`globals.defaults.cardSkin`
 *    指向它;
 * 2. 每个带 `overrides.cardLayout` 的订阅 → 折一套「<UP 名> 专用」,`overrides.cardSkin`
 *    指向它。**同内容只落一份**(两个 UP 版式一样、或某个 UP 的版式其实就等于全局),
 *    按稳定序列化比对 —— 决策 17 说的是「若与全局**不同**」才派生;
 * 3. 旧键从全局与各订阅里**真的删掉**并落盘,下次开机什么都不做。
 *
 * ## 「跑过没有」怎么判 —— 一条:**键还在不在**
 *
 * `GlobalDefaultsSchema.cardLayout` 已经从 `.default(DEFAULT_CARD_LAYOUT)` 改成
 * `.optional()`(见 `schema/globals.ts` 上那段注释),所以这个键删得掉了:
 *
 * - **键在** = 这台机器还没迁过 → 折 + 删键 + 落盘;
 * - **键不在** = 迁过了(或者是全新安装,压根没有过旧版式)→ 一个字节都不写。
 *
 * 「值等不等于出厂版式」**不是**这个判据,它只回答另一个问题:要不要真的折一套皮肤出来。
 * 主人的版式本来就是默认那套时,什么都不用折,但键照样要删 —— 否则下次开机又白跑一趟。
 * (旧版本拿值当判据是被 `.default` 逼的:键删不掉,只能用「回到默认值」冒充「删掉」,
 * 代价是主人哪天把版式手动改回默认又会被当成存量用户重折一套。)
 *
 * ## 三个显隐开关
 *
 * `cardStyle` 的 `showPopularity` / `showArea` / `showFans` 画在「直播数据」**一个复合块
 * 里面**,块级的 `showIf` 管不到块内一行 —— 所以关过开关的存量用户折出来的直播卡把数据块
 * 换成 popularity / area / fans 三个**原子块**拼(ADR-0014 决策 16 的 🔗 复核条),由
 * `cardLayoutToSkin` 的第三个参数 `toggles` 做。全局那份从 `globals.defaults.cardStyle` 取,
 * 每位 UP 那份从 `resolveCardStyleForKind(defaults, ov, "live")` 取(per-kind 覆盖也算数)。
 *
 * ## 退役的渐变起 / 止色
 *
 * `cardStyle.cardColorStart / cardColorEnd` 同样退役(决策 15 的 🔗):颜色归皮肤自己的外框
 * CSS。改过颜色的存量用户与改过版式的走**同一条迁移、同一套皮肤**(第四个参数 `colors`),
 * 颜色等于出厂值 / 等于全局生效值的不派生。
 *
 * **例外(2026-09-14,决策 16 的 🔗)**:全局**只**改过颜色(版式与三个开关都是出厂的、
 * 也没有按卡种另给一份)的那位,不派皮肤 —— 两个色写进默认皮肤的**旋钮覆盖**
 * (`globals.defaults.cardSkinKnobs.default`),人留在默认皮肤上,以后跟着出厂外观一起
 * 升级。走不了这条路的是有 per-kind / per-UP 颜色差异的人:旋钮全局一份,分不出卡种也
 * 分不出 UP,他们照旧派生皮肤(派生皮肤的渐变旋钮仍然拧得动,存量色进的是兜底位)。这两个键与 `cardLayout` 一样是「跑过没有」的判据,
 * 所以触发条件是「有旧 `cardLayout` **或** 任何一处 `cardStyle` 还带着这两个键」,迁完从
 * **四个位置**删干净:全局 `cardStyle`、全局 `cardStyleByKind.<kind>`、每个订阅的
 * `overrides.cardStyle` 与 `overrides.cardStyleByKind.<kind>`。
 *
 * 哪种卡吃哪份颜色,照的是**今天出图的样子**:直播 / 动态卡吃 per-kind 解析后的那份(per-UP
 * 覆盖算数),锐评两张与词云恒吃**全局**那份(渲染器给它们的颜色一直取自全局 `cardStyle`,
 * 不走 per-UP 的 colorOptions),SC / 上舰的底色按价位档与舰长等级走、与用户颜色无关。
 */

import {
	CARD_SKIN_LIMITS,
	type CardKind,
	type CardLayout,
	type CardSkinColors,
	type CardSkinGradient,
	type CardSkinKind,
	type CardStyleByKind,
	type CardStylePartial,
	cardLayoutToSkin,
	DEFAULT_CARD_GRADIENT,
	DEFAULT_CARD_LAYOUT,
	DEFAULT_CARD_SKIN_ID,
	DEFAULT_SKIN_KNOB_KEYS,
	type GlobalConfig,
	type GlobalDefaults,
	type LiveDataToggles,
	normalizeCardLayout,
	resolveCardStyleForKind,
	type Subscription,
	type SubscriptionOverrides,
} from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import type { ConfigStore } from "../config/store.js";
import { CARD_SKIN_MANIFEST_FILE } from "./package.js";
import type { CardSkinStore } from "./store.js";

/** 迁移产物的来历。决策 17 要的「出图不变、**来历可见**」里的后半句。 */
const MIGRATED_DESCRIPTION = "升级时从旧版的卡片版式自动折出来的。";

export interface CardLayoutMigrationResult {
	/** 这一趟新落了几套皮肤(去重之后)。三项全零 = 没有存量版式要迁。 */
	created: number;
	/** 全局那份折出来了没有。 */
	global: boolean;
	/** 有几个订阅从「自带版式」改成了「指一套皮肤」。 */
	subscriptions: number;
	/** 全局那对颜色落成了默认皮肤的**旋钮覆盖**(而不是折出一套皮肤)。 */
	globalKnobs: boolean;
}

/**
 * 跑一趟迁移。幂等:没有存量版式时一个字节都不写(连 `replaceSections` 都不调,
 * 免得白发一轮 `config-changed`)。
 */
export async function migrateCardLayoutsToSkins(deps: {
	store: CardSkinStore;
	config: Pick<ConfigStore, "getGlobals" | "getSubscriptions" | "replaceSections">;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<CardLayoutMigrationResult> {
	const { store, config, logger } = deps;
	await store.ensureReady();

	const globals = config.getGlobals();
	const legacyGlobal = globals.defaults.cardLayout;
	const result: CardLayoutMigrationResult = {
		created: 0,
		global: false,
		subscriptions: 0,
		globalKnobs: false,
	};

	// 键不在 = 迁过了(或全新安装)。两组退役的键(版式 / 颜色)任何一处还在都算存量 ——
	// 颜色可以在没有旧版式的机器上单独存在(只改过配色的用户),不能只看 `cardLayout`。
	const hasLegacy =
		legacyGlobal !== undefined ||
		hasRetiredColors(globals.defaults.cardStyle) ||
		hasRetiredColorsByKind(globals.defaults.cardStyleByKind) ||
		config
			.getSubscriptions()
			.some(
				(s) =>
					s.overrides.cardLayout !== undefined ||
					hasRetiredColors(s.overrides.cardStyle) ||
					hasRetiredColorsByKind(s.overrides.cardStyleByKind),
			);
	if (!hasLegacy) return result;
	// 「有旧键但值就是出厂版式」也算存量:键要删,只是不用折皮肤。
	const globalLayout = legacyGlobal ?? DEFAULT_CARD_LAYOUT;
	/** 全局那三个显隐开关(退役中);关过任何一个 → 直播卡的数据区折成原子块拼装。 */
	const globalToggles: LiveDataToggles = togglesOf(globals.defaults.cardStyle);
	/** 全局那对退役的渐变色;等于出厂色时是 undefined(= 不折)。 */
	const globalColors = colorsOf(globals.defaults, null);

	/**
	 * 版式签名 → 已经落好的那套皮肤。全局那份**先占位**:某个 UP 的覆盖内容其实等于全局
	 * 时,它要的就是全局那套,不该再派生第二套(决策 17「若与全局不同」)。
	 */
	const bySignature = new Map<string, string>();

	let globalSkinId = globals.defaults.cardSkin;
	const globalSig = signature([globalLayout, globalToggles, globalColors]);
	const factorySig = signature([DEFAULT_CARD_LAYOUT, ALL_ON, undefined]);
	/**
	 * **只有颜色变过**(版式与三个开关都是出厂的,而且没有按卡种另给一份)——
	 * 这种人不该被派一套皮肤(2026-09-14 主人拍板):颜色落成默认皮肤的**旋钮覆盖**,
	 * 他留在默认皮肤上,以后跟着出厂外观一起升级。有 `byKind` 差异的走不了这条路 ——
	 * 旋钮是全局一份,分不出卡种。
	 */
	const colorOnly =
		globalColors !== undefined &&
		globalColors.byKind === undefined &&
		globalColors.base !== undefined &&
		signature([globalLayout, globalToggles, undefined]) === factorySig;
	// 已经指着一套非默认皮肤 = 主人自己选过,别拿旧版式盖掉他的选择。
	const migrateGlobal =
		globalSkinId === DEFAULT_CARD_SKIN_ID && !colorOnly && globalSig !== factorySig;
	if (migrateGlobal) {
		globalSkinId = await installSkin(
			store,
			globalLayout,
			globalToggles,
			globalColors,
			"自定义(迁移自旧版式)",
			logger,
		);
		result.created += 1;
		result.global = true;
	}
	bySignature.set(globalSig, globalSkinId);

	const nextSubs: Subscription[] = [];
	let subsChanged = false;
	for (const sub of config.getSubscriptions()) {
		const legacy = sub.overrides.cardLayout;
		// per-UP 的三个开关可能与全局不同(cardStyle / cardStyleByKind 都能覆盖),所以
		// 即使这个 UP 没有自己的版式,只要开关不一样就得单独折一套 —— 否则他的直播卡会
		// 跟着全局那套皮肤画出被他关掉的那几行。
		const toggles = togglesOf(resolveCardStyleForKind(globals.defaults, sub.overrides, "live"));
		// 颜色同理:这位 UP 覆盖过颜色(整份或 per-kind)就得单独折一套,否则他的卡会跟着
		// 全局那套皮肤画出全局的渐变。
		const colors = colorsOf(globals.defaults, sub.overrides);
		const layout = legacy
			? // 与 `resolve()` 同一道归一化:存量覆盖可能缺块(是更早的版本存下的),而这个 UP
				// 今天出的图正是归一化之后那份 —— 折皮肤要照着**看得见的那个**折。
				normalizeCardLayout(legacy, globalLayout)
			: globalLayout;
		const sig = signature([layout, toggles, colors]);
		// 旧键先摘干净:哪怕这位 UP 什么皮肤都不用折,那三个退役的键也得从他的覆盖里消失。
		const stripped = stripRetiredKeys(sub.overrides);
		if (!legacy && sig === globalSig) {
			// 版式 / 开关 / 颜色都与全局一样 → 继承全局那套,除了摘键什么都不动。
			nextSubs.push(stripped === sub.overrides ? sub : { ...sub, overrides: stripped });
			subsChanged ||= stripped !== sub.overrides;
			continue;
		}
		let skinId = bySignature.get(sig);
		if (!skinId) {
			skinId = await installSkin(
				store,
				layout,
				toggles,
				colors,
				`${sub.name || sub.uid} 专用`,
				logger,
			);
			bySignature.set(sig, skinId);
			result.created += 1;
		}
		// 指回全局那套 = 不用覆盖(少一层是一层);已经自己选过皮肤的也不动。
		const keepInherited = skinId === globalSkinId || stripped.cardSkin !== undefined;
		nextSubs.push({
			...sub,
			overrides: keepInherited ? stripped : { ...stripped, cardSkin: skinId },
		});
		subsChanged = true;
		result.subscriptions += 1;
	}

	/**
	 * 只改过颜色的那条路:把两个色写进默认皮肤的旋钮覆盖。**合并不覆盖** —— 面板上
	 * 可能已经有别的旋钮值了(虽然这一趟通常是首次升级,但迁移得幂等到不吃掉别人的键)。
	 */
	let nextKnobs = globals.defaults.cardSkinKnobs;
	if (colorOnly && globalSkinId === DEFAULT_CARD_SKIN_ID && globalColors?.base) {
		const K = DEFAULT_SKIN_KNOB_KEYS;
		nextKnobs = {
			...nextKnobs,
			[DEFAULT_CARD_SKIN_ID]: {
				...nextKnobs?.[DEFAULT_CARD_SKIN_ID],
				[K.gradientStart]: globalColors.base.start,
				[K.gradientEnd]: globalColors.base.end,
			},
		};
		result.globalKnobs = true;
	}

	// 旧键就地丢掉 —— **哪怕什么皮肤都没折**:键留着下次开机还会再跑一趟。
	// 整体替换而不是一串 patch:两个分区要么一起成要么一起不动,半新半旧的配置会让
	// 订阅指着一套并不存在的皮肤。
	const { cardLayout: _retiredGlobal, ...defaults } = globals.defaults;
	const nextGlobals: GlobalConfig = {
		...globals,
		defaults: {
			...defaults,
			cardStyle: stripColors(defaults.cardStyle),
			cardStyleByKind: stripColorsByKind(defaults.cardStyleByKind) ?? {},
			cardSkin: globalSkinId,
			cardSkinKnobs: nextKnobs ?? {},
		},
	};
	await config.replaceSections({
		globals: nextGlobals,
		...(subsChanged ? { subscriptions: nextSubs } : {}),
	});
	logger?.info(
		`[card-skin] 旧版式迁移完成:新增 ${result.created} 套皮肤` +
			`(全局 ${result.global ? "1" : "0"} 套,${result.subscriptions} 个订阅改指皮肤` +
			`${result.globalKnobs ? ",全局配色落成默认皮肤的旋钮" : ""})`,
	);
	return result;
}

/**
 * 把一份版式落成一套皮肤,**走装包那扇门**。
 *
 * 不另开一个「按对象建一套」的口子:验+洗只此一家,迁移产物与主人手传的包受同一把尺。
 * 代价是拼一个只有清单的 zip 再拆开 —— 开机一次、几十 KB,换「迁移产物不可能绕过清洗」。
 */
async function installSkin(
	store: CardSkinStore,
	layout: CardLayout,
	toggles: LiveDataToggles,
	colors: CardSkinColors | undefined,
	name: string,
	logger?: { warn: (msg: string) => void },
): Promise<string> {
	const manifest = {
		...cardLayoutToSkin(layout, undefined, toggles, colors),
		// 名字是主人填的 UP 昵称拼出来的,可能比 schema 的上限长 —— 截断,别让一次开机
		// 迁移死在「名字太长」上。
		name: name.slice(0, CARD_SKIN_LIMITS.name.max),
		description: MIGRATED_DESCRIPTION,
	};
	const zip = zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(manifest)) });
	const { id, warnings } = await store.install(zip);
	for (const w of warnings) logger?.warn(`[card-skin] 迁移「${name}」:${w}`);
	return id;
}

/** 三个开关都开 = 数据区照旧用复合块,折出来与旧默认皮肤一字不差。 */
const ALL_ON: LiveDataToggles = { showPopularity: true, showArea: true, showFans: true };

/** 从一份 `cardStyle` 里抠出那三个退役中的显隐开关。 */
function togglesOf(style: LiveDataToggles): LiveDataToggles {
	return {
		showPopularity: style.showPopularity,
		showArea: style.showArea,
		showFans: style.showFans,
	};
}

// ── 退役的渐变起 / 止色 ───────────────────────────────────────────────────────

/** 这一份样式(或它的 partial)还带着那两个退役的颜色键吗。 */
function hasRetiredColors(style: CardStylePartial | undefined): boolean {
	return style?.cardColorStart !== undefined || style?.cardColorEnd !== undefined;
}

/** 按卡种那张表里有没有哪一格还带着颜色键。 */
function hasRetiredColorsByKind(byKind: CardStyleByKind | undefined): boolean {
	return Object.values(byKind ?? {}).some((s) => hasRetiredColors(s));
}

/** 一份样式里那对颜色;缺的补出厂色 —— 「没设过」与「设成出厂色」在出图上本就一样。 */
function gradientOf(style: CardStylePartial): CardSkinGradient {
	return {
		start: style.cardColorStart ?? DEFAULT_CARD_GRADIENT[0],
		end: style.cardColorEnd ?? DEFAULT_CARD_GRADIENT[1],
	};
}

const sameGradient = (a: CardSkinGradient, b: CardSkinGradient): boolean =>
	a.start === b.start && a.end === b.end;

/** 直播 / 动态是仅有的两种既吃用户色、又有 per-kind 与 per-UP 覆盖的卡。 */
const COLORED_CARD_KINDS = ["live", "dynamic"] as const satisfies readonly CardKind[];

/**
 * 一位 UP(`overrides`,全局那份传 `null`)生效的那几对颜色,折成 `cardLayoutToSkin` 的
 * `colors` 参数。**全等出厂色时返回 `undefined`** —— 签名比对靠它,别返回一个「内容等于
 * 出厂」的对象,那会让没改过颜色的人也被派一套皮肤。
 *
 * `base` 恒取**全局**那份:锐评两张与词云的颜色在渲染器里一直读的是全局 `cardStyle`
 * (`this.config.*`),per-UP 的 colorOptions 到不了它们那儿 —— 照搬这个事实,迁完出图才不变。
 */
function colorsOf(
	defaults: GlobalDefaults,
	overrides: SubscriptionOverrides | null,
): CardSkinColors | undefined {
	const base = gradientOf(defaults.cardStyle);
	const byKind: Partial<Record<CardSkinKind, CardSkinGradient>> = {};
	for (const kind of COLORED_CARD_KINDS) {
		const g = gradientOf(resolveCardStyleForKind(defaults, overrides, kind));
		if (!sameGradient(g, base)) byKind[kind] = g;
	}
	const hasKind = Object.keys(byKind).length > 0;
	const isFactory = sameGradient(base, {
		start: DEFAULT_CARD_GRADIENT[0],
		end: DEFAULT_CARD_GRADIENT[1],
	});
	if (isFactory && !hasKind) return undefined;
	return hasKind ? { base, byKind } : { base };
}

/** 摘掉一份样式里那两个退役的键;没有就返回原引用(调用方靠引用判「动没动」)。 */
function stripColors<T extends CardStylePartial>(style: T): T {
	if (!hasRetiredColors(style)) return style;
	const { cardColorStart: _s, cardColorEnd: _e, ...rest } = style;
	return rest as T;
}

/**
 * 按卡种那张表逐格摘键。摘完空掉的那一格整个丢掉(空覆盖是 no-op,留着只是残渣),
 * 整张表都空了返回 `undefined`。没东西可摘就返回原引用。
 */
function stripColorsByKind(byKind: CardStyleByKind | undefined): CardStyleByKind | undefined {
	if (byKind === undefined || !hasRetiredColorsByKind(byKind)) return byKind;
	const out: CardStyleByKind = {};
	for (const [kind, style] of Object.entries(byKind) as Array<[CardKind, CardStylePartial]>) {
		const next = stripColors(style);
		if (Object.keys(next).length > 0) out[kind] = next;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 一位 UP 的覆盖里所有退役键(`cardLayout` + 两处颜色)一起摘掉。什么都不用摘时返回
 * **原引用** —— 上面靠 `!==` 判这条订阅要不要重写。
 */
function stripRetiredKeys(ov: SubscriptionOverrides): SubscriptionOverrides {
	const style = ov.cardStyle === undefined ? undefined : stripColors(ov.cardStyle);
	const byKind = stripColorsByKind(ov.cardStyleByKind);
	if (ov.cardLayout === undefined && style === ov.cardStyle && byKind === ov.cardStyleByKind) {
		return ov;
	}
	const { cardLayout: _retired, cardStyle: _cs, cardStyleByKind: _bk, ...rest } = ov;
	const out: SubscriptionOverrides = { ...rest };
	if (style !== undefined && Object.keys(style).length > 0) out.cardStyle = style;
	if (byKind !== undefined) out.cardStyleByKind = byKind;
	return out;
}

/** 稳定序列化:对象键按字典序,数组按原序。「两份版式内容一样」的唯一判据。 */
function signature(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const src = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(src)
				.sort()
				.map((k) => [k, sortKeys(src[k])]),
		);
	}
	return value;
}
