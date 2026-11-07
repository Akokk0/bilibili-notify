/**
 * AI 设置页服务商管理与默认性格选择 —— 对 `AISettingsDraft` 草稿的纯变换。
 *
 * 抽出来是因为这里的分支最容易悄悄错、又最难在界面上看出来:删掉正在用的那份之后
 * 指针指向哪、删到一份不剩会不会炸、新实例的 id 撞没撞上。性格内容管理由资源库负责。
 */

import {
	AI_PROVIDER_IDS,
	type AIProviderId,
	aiProfileAt,
	EMPTY_AI_PROVIDER_PROFILE,
	presetsOf,
	providerMeta,
} from "@bilibili-notify/internal/ai";
import type { BuiltinPreset } from "@bilibili-notify/internal/texts/builtin";
import { i18n } from "../../i18n";
import type { AISettingsDraft } from "../../types/globals";

type AIPreset = AISettingsDraft["presets"][number];
/** 当前语言的内置人格(设置里不存它们的内容,每次按当前语言取)。 */
type Builtins = readonly BuiltinPreset[];
/** 左栏里的一份:没删的内置,或主人自己的。 */
type RailPreset = BuiltinPreset | AIPreset;

// ── 服务商实例左栏 ──────────────────────────────────────────────────────
//
// 连接与生成配置按**实例**存(`ai.providers[实例id]`),同一家服务商可以有多份
// (两个 DeepSeek 号)。`ai.activeProfile` 指着女仆正用的那份。

/** 左栏一行。`label` 已经解析成显示名 —— 空名回落到注册表里那家的名字。 */
export interface ProfileRailItem {
	id: string;
	provider: AIProviderId;
	label: string;
}

/**
 * 左栏顺序:**注册表序分家,同家内按添加先后**(对象键序 = 插入序)。
 *
 * 纯键序的话,主人先加硅基后加 OpenRouter,左栏就与「+ 添加服务商」清单里的
 * 顺序不一致;删掉再加回来还会自己换位置。
 */
function railOrder(ai: AISettingsDraft): string[] {
	const rank = new Map<string, number>(AI_PROVIDER_IDS.map((id, i) => [id, i]));
	return Object.keys(ai.providers)
		.map((id, at) => ({
			id,
			at,
			rank: rank.get(ai.providers[id]?.provider ?? "") ?? AI_PROVIDER_IDS.length,
		}))
		.sort((a, b) => a.rank - b.rank || a.at - b.at)
		.map((x) => x.id);
}

export function profileRailItems(ai: AISettingsDraft): ProfileRailItem[] {
	return railOrder(ai).map((id) => {
		const p = ai.providers[id];
		const provider = p?.provider ?? "custom";
		return { id, provider, label: p?.label || providerMeta(provider).label };
	});
}

/**
 * 添加一份实例:建一只空桶,盖上 provider 章,交回新实例 id 好当场切过去编辑。
 *
 * - **id 挑第一个空位**(`deepseek` → `deepseek-2` → …),跳过已占用的 —— 撞键
 *   等于拿空档案盖掉主人填好的 key,不可逆。
 * - **同家的后续实例默认名带序号**(「DeepSeek 2」):左栏两行都叫「DeepSeek」的话
 *   主人分不清哪只是哪只;头一份留空名,显示时回落到家名。
 * - **不抢指针** —— 「添加」与「换用」是两件事,后者是「全局配置」里那个选择器的事
 *   (与人格的 `activePreset` 同一套语义)。唯一的例外是指针为空且没有实例时(全新配置):
 *   头一份添加的就成了在用的那份,否则主人填好密钥、女仆却仍然「没配齐」。
 */
export function addProfile(
	ai: AISettingsDraft,
	provider: AIProviderId,
): { ai: AISettingsDraft; id: string } {
	const taken = new Set(Object.keys(ai.providers));
	let id: string = provider;
	let n = 1;
	while (taken.has(id)) {
		n += 1;
		id = `${provider}-${n}`;
	}
	const sameFamily = Object.values(ai.providers).some((p) => p?.provider === provider);
	const label = sameFamily ? `${providerMeta(provider).label} ${n}` : "";
	const isFirstProfile = ai.activeProfile === "" && taken.size === 0;
	return {
		id,
		ai: {
			...ai,
			activeProfile: isFirstProfile ? id : ai.activeProfile,
			providers: {
				...ai.providers,
				[id]: { ...EMPTY_AI_PROVIDER_PROFILE, provider, label },
			},
		},
	};
}

/**
 * 「设为默认」—— 把全局指针拨到这一份。
 *
 * 桶不存在就**不动**:指向一份没添加过的实例是悬空引用,左栏里没有它、
 * `resolveAIProfile` 兜一套空档案,于是女仆静默停工而主人以为选好了。
 */
export function setActiveProfile(ai: AISettingsDraft, id: string): AISettingsDraft {
	if (ai.providers[id] === undefined) return ai;
	return { ...ai, activeProfile: id };
}

/** 给实例改显示名。清空 = 回落到注册表里那家的名字(见 {@link profileRailItems})。 */
export function renameProfile(ai: AISettingsDraft, id: string, label: string): AISettingsDraft {
	const p = ai.providers[id];
	if (p === undefined) return ai;
	return { ...ai, providers: { ...ai.providers, [id]: { ...p, label } } };
}

/**
 * 把「左栏在看哪一份」收敛到一份**真实存在**的。
 *
 * 它与 `ai.activeProfile`(女仆真正在用的那份)是两个独立的东西 —— 点左栏只换看的
 * 对象,不换用的那份。曾经这两件事共用一个字段,于是「想看看另一份的配置」等于
 * 当场换掉了女仆在用的那份,而界面上没有任何提示。
 *
 * 收敛顺序:看的那份还在 → 原样;否则落到在用的那份;在用的那份也没添加过(全新
 * 配置、或删到只剩别份)→ 左栏第一项(与渲染同序);一份都没有 → null,右侧出添加面板。
 */
export function resolveEditingProfile(ai: AISettingsDraft, id: string | null): string | null {
	if (id !== null && aiProfileAt(ai.providers, id) !== undefined) return id;
	if (aiProfileAt(ai.providers, ai.activeProfile) !== undefined) return ai.activeProfile;
	return railOrder(ai)[0] ?? null;
}

/**
 * 删掉一份实例:桶整个移除(不留空壳,否则左栏还会列着它)。
 *
 * 删的正是在用的那份时,指针落到**左栏剩下的第一项** —— 与渲染同序,否则删完之后
 * 高亮项与右侧内容各说各话。删到一份不剩时指针**原样留着**:那是允许的悬空引用,
 * `resolveAIProfile` 明确兜空默认值,页面据此显示空态、引擎据此判定「没配齐」。
 *
 * 这份的密钥不用在这里处理:落盘时 `writeGlobals` 用 `collectAiSecrets` 整袋重算,
 * 桶没了它自然不再写进加密袋。
 */
export function removeProfile(ai: AISettingsDraft, id: string): AISettingsDraft {
	if (ai.providers[id] === undefined) return ai;
	// 用「浅拷贝 + delete」而非计算键 rest 解构:后者会让 TS 把 rest 推成 `{}`,
	// 之后按字符串索引就报隐式 any。
	const rest: AISettingsDraft["providers"] = { ...ai.providers };
	delete rest[id];
	const fallback = railOrder({ ...ai, providers: rest })[0];
	return {
		...ai,
		activeProfile: ai.activeProfile === id && fallback !== undefined ? fallback : ai.activeProfile,
		providers: rest,
	};
}

// ── 人格左栏 ────────────────────────────────────────────────────────────
//
// 左栏 = `presetsOf`:没删的内置(内容取当前语言)+ 主人自己的(`presets[]`)。设置里只记
// 「删了哪几份内置」(`removedBuiltinPresets`,缺 = 一份没删)与主人自己的;`activePreset`
// 指着左栏里全局当前用的那一份。

/** 左栏 id = `preset:<id>`。留前缀是为了与将来可能出现的别种行天然分开命名空间。 */
const PRESET_RAIL_PREFIX = "preset:";

export interface PersonaRailItem {
	/** 左栏 id(带前缀)。 */
	id: string;
	/** 原始 preset id。调用方拿它查图标之类,免得在组件里切字符串。 */
	presetId: string;
	label: string;
}

/** 左栏里的全部人格(顺序即左栏顺序)。 */
function railPresets(ai: AISettingsDraft, builtins: Builtins): RailPreset[] {
	return presetsOf(ai, builtins);
}

export function personaRailItems(ai: AISettingsDraft, builtins: Builtins): PersonaRailItem[] {
	return railPresets(ai, builtins).map((p) => ({
		id: `${PRESET_RAIL_PREFIX}${p.id}`,
		presetId: p.id,
		label: p.label || i18n.t("aiSettings.persona.unnamedLabel"),
	}));
}

/** 左栏 id → 左栏里的下标。不是预设、或该预设已不在左栏时返回 -1。 */
function railIndex(ai: AISettingsDraft, builtins: Builtins, railId: string): number {
	if (!railId.startsWith(PRESET_RAIL_PREFIX)) return -1;
	const id = railId.slice(PRESET_RAIL_PREFIX.length);
	return railPresets(ai, builtins).findIndex((p) => p.id === id);
}

/**
 * 把左栏选中项收敛到一个**真实存在**的 id。
 *
 * 选中项可能凭空消失(刚被删掉、备份导入换了一批)。不收敛的话左栏没有任何一项高亮、
 * 右侧却显示着别的内容 —— 高亮项与内容各说各话。
 */
export function resolvePersonaRailId(
	ai: AISettingsDraft,
	builtins: Builtins,
	railId: string,
): string {
	if (railIndex(ai, builtins, railId) >= 0) return railId;
	const first = railPresets(ai, builtins)[0];
	return first ? `${PRESET_RAIL_PREFIX}${first.id}` : "";
}

/** 全局此刻用的是哪一份 —— 读 `ai.activePreset` 指针,换算成左栏 id。 */
export function globalPersonaRailId(ai: AISettingsDraft, builtins: Builtins): string {
	return resolvePersonaRailId(ai, builtins, `${PRESET_RAIL_PREFIX}${ai.activePreset ?? ""}`);
}

/**
 * 「设为默认」——**改指针,不复制**。
 *
 * 旧界面靠「把预设复制进 `ai.persona`」来表达选中,那一下就把主人手写的全局人格盖掉
 * 且换不回来;想显示「现在选的是哪份」还得拿 persona 去逐字段比对猜。指针把两个毛病
 * 一并解决。
 */
export function setGlobalPersona(
	ai: AISettingsDraft,
	builtins: Builtins,
	railId: string,
): AISettingsDraft {
	const i = railIndex(ai, builtins, railId);
	if (i < 0) return ai;
	return { ...ai, activePreset: railPresets(ai, builtins)[i]?.id };
}
