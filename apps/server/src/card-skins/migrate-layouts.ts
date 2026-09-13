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
 */

import {
	CARD_SKIN_LIMITS,
	type CardLayout,
	cardLayoutToSkin,
	DEFAULT_CARD_LAYOUT,
	DEFAULT_CARD_SKIN_ID,
	type GlobalConfig,
	type LiveDataToggles,
	normalizeCardLayout,
	resolveCardStyleForKind,
	type Subscription,
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
	const result: CardLayoutMigrationResult = { created: 0, global: false, subscriptions: 0 };

	// 键不在 = 迁过了(或全新安装)。订阅那侧的旧键只可能与全局的一起存在 —— 它们是同一个
	// 版本写下的,而且这一趟要么全写要么全不写(见下面 replaceSections 那段)。
	const hasLegacy =
		legacyGlobal !== undefined ||
		config.getSubscriptions().some((s) => s.overrides.cardLayout !== undefined);
	if (!hasLegacy) return result;
	// 「有旧键但值就是出厂版式」也算存量:键要删,只是不用折皮肤。
	const globalLayout = legacyGlobal ?? DEFAULT_CARD_LAYOUT;
	/** 全局那三个显隐开关(退役中);关过任何一个 → 直播卡的数据区折成原子块拼装。 */
	const globalToggles: LiveDataToggles = togglesOf(globals.defaults.cardStyle);

	/**
	 * 版式签名 → 已经落好的那套皮肤。全局那份**先占位**:某个 UP 的覆盖内容其实等于全局
	 * 时,它要的就是全局那套,不该再派生第二套(决策 17「若与全局不同」)。
	 */
	const bySignature = new Map<string, string>();

	let globalSkinId = globals.defaults.cardSkin;
	// 已经指着一套非默认皮肤 = 主人自己选过,别拿旧版式盖掉他的选择。
	const migrateGlobal =
		globalSkinId === DEFAULT_CARD_SKIN_ID &&
		signature([globalLayout, globalToggles]) !== signature([DEFAULT_CARD_LAYOUT, ALL_ON]);
	if (migrateGlobal) {
		globalSkinId = await installSkin(
			store,
			globalLayout,
			globalToggles,
			"自定义(迁移自旧版式)",
			logger,
		);
		result.created += 1;
		result.global = true;
	}
	bySignature.set(signature([globalLayout, globalToggles]), globalSkinId);

	const nextSubs: Subscription[] = [];
	let subsChanged = false;
	for (const sub of config.getSubscriptions()) {
		const legacy = sub.overrides.cardLayout;
		// per-UP 的三个开关可能与全局不同(cardStyle / cardStyleByKind 都能覆盖),所以
		// 即使这个 UP 没有自己的版式,只要开关不一样就得单独折一套 —— 否则他的直播卡会
		// 跟着全局那套皮肤画出被他关掉的那几行。
		const toggles = togglesOf(resolveCardStyleForKind(globals.defaults, sub.overrides, "live"));
		const layout = legacy
			? // 与 `resolve()` 同一道归一化:存量覆盖可能缺块(是更早的版本存下的),而这个 UP
				// 今天出的图正是归一化之后那份 —— 折皮肤要照着**看得见的那个**折。
				normalizeCardLayout(legacy, globalLayout)
			: globalLayout;
		const sig = signature([layout, toggles]);
		if (!legacy && sig === signature([globalLayout, globalToggles])) {
			// 版式与开关都与全局一样 → 继承全局那套,什么都不用动。
			nextSubs.push(sub);
			continue;
		}
		let skinId = bySignature.get(sig);
		if (!skinId) {
			skinId = await installSkin(store, layout, toggles, `${sub.name || sub.uid} 专用`, logger);
			bySignature.set(sig, skinId);
			result.created += 1;
		}
		const { cardLayout: _retired, ...overrides } = sub.overrides;
		// 指回全局那套 = 不用覆盖(少一层是一层);已经自己选过皮肤的也不动。
		const keepInherited = skinId === globalSkinId || overrides.cardSkin !== undefined;
		nextSubs.push({
			...sub,
			overrides: keepInherited ? overrides : { ...overrides, cardSkin: skinId },
		});
		subsChanged = true;
		result.subscriptions += 1;
	}

	// 旧键就地丢掉 —— **哪怕什么皮肤都没折**:键留着下次开机还会再跑一趟。
	// 整体替换而不是一串 patch:两个分区要么一起成要么一起不动,半新半旧的配置会让
	// 订阅指着一套并不存在的皮肤。
	const { cardLayout: _retiredGlobal, ...defaults } = globals.defaults;
	const nextGlobals: GlobalConfig = {
		...globals,
		defaults: { ...defaults, cardSkin: globalSkinId },
	};
	await config.replaceSections({
		globals: nextGlobals,
		...(subsChanged ? { subscriptions: nextSubs } : {}),
	});
	logger?.info(
		`[card-skin] 旧版式迁移完成:新增 ${result.created} 套皮肤` +
			`(全局 ${result.global ? "1" : "0"} 套,${result.subscriptions} 个订阅改指皮肤)`,
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
	name: string,
	logger?: { warn: (msg: string) => void },
): Promise<string> {
	const manifest = {
		...cardLayoutToSkin(layout, undefined, toggles),
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
