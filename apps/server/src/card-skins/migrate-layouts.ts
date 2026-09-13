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
 * 3. 旧键从全局与各订阅里去掉并落盘,下次开机什么都不做。
 *
 * ## 「跑过没有」怎么判(两条路里选了哪条)
 *
 * 判据是**值**:`cardLayout` 与 `DEFAULT_CARD_LAYOUT` 不同才算「主人改过」。
 * 不用「raw JSON 里有没有这个键」是因为那条路根本合不拢:`GlobalConfigSchema` 上
 * `cardLayout` 带着 `.default(DEFAULT_CARD_LAYOUT)`(留给老 globals.json 的迁移友好策略),
 * zod 每次 parse 都把它补回来 —— 落盘的是 parse 产物,所以这个键在全局那侧**删不掉**,
 * 拿「键在不在」当判据的话第二趟还会再折一套。
 *
 * 于是全局那侧的「删掉」等价于**回到默认值**(键还在、值是出厂版式,出图早已不读它);
 * 订阅那侧 `overrides.cardLayout` 是 `.optional()`,删掉就是真的没了。等旧键整个从 schema
 * 里退役时,全局那半自然跟着消失。
 *
 * ## TODO(下一片)
 *
 * `cardStyle` 的三个显隐开关(`showPopularity` / `showArea` / `showFans`)**这轮不迁** ——
 * 它们画在「直播数据」一个复合块里面,块级的 `showIf` 管不到块内一行,得等「数据块拆成
 * popularity / area / fans 三个原子块」那一片落地,才能把关过开关的存量用户折成用原子块
 * 拼出来的派生皮肤(ADR-0014 决策 16 的 🔗 复核条)。届时那一步要并进这里同一趟迁移:
 * 分两趟的话,先跑的这趟已经把 `cardLayout` 收拾干净了,后跑的那趟认不出谁是存量用户。
 */

import {
	CARD_SKIN_LIMITS,
	type CardLayout,
	cardLayoutToSkin,
	DEFAULT_CARD_LAYOUT,
	DEFAULT_CARD_SKIN_ID,
	type GlobalConfig,
	normalizeCardLayout,
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
	const globalLayout = globals.defaults.cardLayout;
	const result: CardLayoutMigrationResult = { created: 0, global: false, subscriptions: 0 };

	/**
	 * 版式签名 → 已经落好的那套皮肤。全局那份**先占位**:某个 UP 的覆盖内容其实等于全局
	 * 时,它要的就是全局那套,不该再派生第二套(决策 17「若与全局不同」)。
	 */
	const bySignature = new Map<string, string>();

	let globalSkinId = globals.defaults.cardSkin;
	// 已经指着一套非默认皮肤 = 这台机器要么迁过、要么主人自己选过,别拿旧版式盖掉他的选择。
	const migrateGlobal =
		globalSkinId === DEFAULT_CARD_SKIN_ID &&
		signature(globalLayout) !== signature(DEFAULT_CARD_LAYOUT);
	if (migrateGlobal) {
		globalSkinId = await installSkin(store, globalLayout, "自定义(迁移自旧版式)", logger);
		result.created += 1;
		result.global = true;
	}
	bySignature.set(signature(globalLayout), globalSkinId);

	const nextSubs: Subscription[] = [];
	let subsChanged = false;
	for (const sub of config.getSubscriptions()) {
		const legacy = sub.overrides.cardLayout;
		if (!legacy) {
			nextSubs.push(sub);
			continue;
		}
		// 与 `resolve()` 同一道归一化:存量覆盖可能缺块(是更早的版本存下的),而这个 UP
		// 今天出的图正是归一化之后那份 —— 折皮肤要照着**看得见的那个**折。
		const layout = normalizeCardLayout(legacy, globalLayout);
		const sig = signature(layout);
		let skinId = bySignature.get(sig);
		if (!skinId) {
			skinId = await installSkin(store, layout, `${sub.name || sub.uid} 专用`, logger);
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

	if (!result.global && !subsChanged) return result;

	// 旧键就地丢掉(全局那侧会被 zod 的 `.default` 补回出厂版式,见文件头)。
	// 整体替换而不是一串 patch:两个分区要么一起成要么一起不动,半新半旧的配置会让
	// 订阅指着一套并不存在的皮肤。
	const { cardLayout: _retiredGlobal, ...defaults } = globals.defaults;
	const nextGlobals = { ...globals, defaults: { ...defaults, cardSkin: globalSkinId } };
	await config.replaceSections({
		// 少了 cardLayout 的 defaults 在类型上不是 GlobalConfig,而 zod 会把它补回来。
		...(result.global ? { globals: nextGlobals as GlobalConfig } : {}),
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
	name: string,
	logger?: { warn: (msg: string) => void },
): Promise<string> {
	const manifest = {
		...cardLayoutToSkin(layout),
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
