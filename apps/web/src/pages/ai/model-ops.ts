/**
 * AI 设置页两个左栏的增删操作 —— 对 `AISettingsDraft` 草稿的纯变换,一律返回新对象。
 *
 * 抽出来是因为这里的分支最容易悄悄错、又最难在界面上看出来:删掉正在用的那份之后
 * 指针指向哪、删到一份不剩会不会炸、新实例 / 新人格的 id 撞没撞上。
 */

import {
	AI_PROVIDER_IDS,
	type AIProviderId,
	aiProfileAt,
	EMPTY_AI_PROVIDER_PROFILE,
	presetsOf,
	providerMeta,
} from "@bilibili-notify/internal/ai";
import { BUILTIN_PRESET_IDS, type BuiltinPreset } from "@bilibili-notify/internal/texts/builtin";
import type { AIPersona, AISettingsDraft } from "../../types/globals";

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
 *   (与人格的 `activePreset` 同一套语义)。唯一的例外是指针还没着落时(全新配置):
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
	const pointerLanded = aiProfileAt(ai.providers, ai.activeProfile) !== undefined;
	return {
		id,
		ai: {
			...ai,
			activeProfile: pointerLanded ? ai.activeProfile : id,
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
		label: p.label || "(未命名)",
	}));
}

/** 右侧表单当前编辑的那一份人格。 */
export interface PersonaDraft {
	persona: AIPersona;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
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

/**
 * 取出当前该显示在右侧的那一份。
 *
 * 主人自己那份的两段 prompt 是 optional,`undefined` = 用内置首份的那段,
 * 这里**照实显示为空**而不是把内置文案搬过来充数 —— 后者一保存就把「跟随」坐实成
 * 一份副本,此后内置改了再也带不动它,而界面上完全看不出发生了这件事。
 */
export function personaAt(ai: AISettingsDraft, builtins: Builtins, railId: string): PersonaDraft {
	const list = railPresets(ai, builtins);
	const id = resolvePersonaRailId(ai, builtins, railId).slice(PRESET_RAIL_PREFIX.length);
	// 左栏恒非空(最后一份删不掉);手改配置把它清空了就显示内置首份,与引擎的回落一致
	const preset = list.find((p) => p.id === id) ?? builtins[0];
	return {
		persona: preset?.persona ?? { ...EMPTY_PERSONA },
		dynamicPrompt: preset?.dynamicPrompt ?? "",
		liveSummaryPrompt: preset?.liveSummaryPrompt ?? "",
	};
}

/**
 * 把一次编辑写回对应的那一份(只有主人自己的能改,内置在这里被拦下)。
 *
 * 两段 prompt 走一道转换:**清空 → `undefined`**,也就是恢复「用内置首份的那段」。存成 `""`
 * 的话读取处的 `??` 链不会再落到内置(空串不是 nullish),该预设从此强制发
 * 一段**空** prompt —— 主人看到的是输入框空着,实际效果却截然不同。
 */
export function updatePersonaAt(
	ai: AISettingsDraft,
	builtins: Builtins,
	railId: string,
	patch: Partial<PersonaDraft>,
): AISettingsDraft {
	const id = resolvePersonaRailId(ai, builtins, railId).slice(PRESET_RAIL_PREFIX.length);
	// 内置那几份是只读的参照库。界面上字段已经禁掉,这里是第二道闸 —— 一处漏了
	// 另一处还拦得住,而「内置被改花了」是不可逆的(此后无从恢复)。
	if (!id || isBuiltinPersona(id)) return ai;
	const blankToUndefined = (v: string): string | undefined => (v === "" ? undefined : v);
	const presets = ai.presets.map((p) => {
		if (p.id !== id) return p;
		const next: AIPreset = { ...p };
		if (patch.persona !== undefined) next.persona = patch.persona;
		if (patch.dynamicPrompt !== undefined) {
			next.dynamicPrompt = blankToUndefined(patch.dynamicPrompt);
		}
		if (patch.liveSummaryPrompt !== undefined) {
			next.liveSummaryPrompt = blankToUndefined(patch.liveSummaryPrompt);
		}
		return next;
	});
	return { ...ai, presets };
}

const EMPTY_PERSONA: AIPersona = {
	name: "",
	addressUser: "",
	addressSelf: "",
	traits: "",
	catchphrase: "",
	baseRole: "",
	extraSystemPrompt: "",
};

/** 一个没被内置与主人自己的占用的 `persona-N` id。 */
function freshPersonaId(ai: AISettingsDraft): string {
	const taken = new Set<string>([...BUILTIN_PRESET_IDS, ...ai.presets.map((p) => p.id)]);
	let n = 1;
	while (taken.has(`persona-${n}`)) n += 1;
	return `persona-${n}`;
}

/**
 * 添加一份空白人格,并把它的左栏 id 交回调用方(好当场切过去)。
 *
 * id 逐个递增到不与**任何**已有 id 相撞为止。撞 id 的后果不是报错而是静默串台:
 * per-UP `overrides.ai.preset` 指着那个 id,读取处用 `find()` 取第一个匹配 ——
 * 两份同 id 的预设永远只有前一份生效,主人改后一份怎么改都不见效果。
 *
 * 两段 prompt 留 `undefined` = 一开始就用内置首份的那段,而不是塞两段空串把它坐实。
 */
export function addPersona(
	ai: AISettingsDraft,
	label = "新性格",
): { ai: AISettingsDraft; railId: string } {
	const id = freshPersonaId(ai);
	return {
		ai: { ...ai, presets: [...ai.presets, { id, label, persona: { ...EMPTY_PERSONA } }] },
		railId: `${PRESET_RAIL_PREFIX}${id}`,
	};
}

/**
 * 删掉一份人格:内置的 = 把 id 记进 `removedBuiltinPresets`(内容不动,「从内置恢复」随时找回);
 * 主人自己的 = 从 `presets` 拿掉。
 *
 * **最后一份删不掉**(按左栏总数算:没删的内置 + 主人的)—— AI 总得有一份人格,列表空了右侧就没东西可显示。
 * 删掉的正是全局用着的那份时,指针落到剩下的第一份(而不是变成悬空引用:那会跟着备份导出,
 * 日后又添加一份同 id 的预设时莫名复活)。
 */
export function removePersona(
	ai: AISettingsDraft,
	builtins: Builtins,
	railId: string,
): AISettingsDraft {
	const list = railPresets(ai, builtins);
	const i = railIndex(ai, builtins, railId);
	const target = i >= 0 ? list[i] : undefined;
	if (!target || list.length <= 1) return ai;
	const next: AISettingsDraft = isBuiltinPersona(target.id)
		? {
				...ai,
				removedBuiltinPresets: [...new Set([...(ai.removedBuiltinPresets ?? []), target.id])],
			}
		: { ...ai, presets: ai.presets.filter((p) => p.id !== target.id) };
	if (ai.activePreset !== undefined && ai.activePreset === target.id) {
		next.activePreset = railPresets(next, builtins)[0]?.id;
	}
	return next;
}

/** 给人格改名(内置的锁着,只有主人自己的能改)。 */
export function renamePersona(
	ai: AISettingsDraft,
	builtins: Builtins,
	railId: string,
	label: string,
): AISettingsDraft {
	const id = resolvePersonaRailId(ai, builtins, railId).slice(PRESET_RAIL_PREFIX.length);
	if (!id || isBuiltinPersona(id)) return ai;
	return { ...ai, presets: ai.presets.map((p) => (p.id === id ? { ...p, label } : p)) };
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

// ── 内置人格:只读的参照库 ──────────────────────────────────────────────
//
// 内置那四份在界面上**锁死**:可以删、可以「从内置修改」另存一份可改的副本,但不能
// 就地改。理由很实在:「从内置恢复」要有个稳定的东西可恢复,内置被改花了这条路就断了。
// 判据是 **id** 而不是内容 —— 按内容判会出现「同样是傲娇毒舌,这份能改那份不能」。

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_PRESET_IDS);

export function isBuiltinPersona(presetId: string): boolean {
	return BUILTIN_IDS.has(presetId);
}

/** 被删掉的内置人格 —— 「从内置恢复」列的就是这些(按内置的顺序)。空数组 = 一份没删,入口收起来。 */
export function missingBuiltinPersonas(
	ai: AISettingsDraft,
	builtins: Builtins,
): { id: string; label: string }[] {
	const removed = new Set(ai.removedBuiltinPresets ?? []);
	return builtins
		.filter((p) => removed.has(p.id))
		.map((p) => ({
			id: p.id,
			label: p.label,
		}));
}

/** 深拷贝一份预设。浅拷贝会让副本与原件共享 persona 对象 —— 改副本等于就地改原件。 */
function clonePreset(p: AIPreset): AIPreset {
	return {
		...p,
		persona: { ...p.persona },
	};
}

/**
 * 把某份内置人格找回来:从 `removedBuiltinPresets` 里拿掉它的 id(拿空了就删键)。
 * 内置的位置由内置的顺序定,恢复一次清单不会乱。
 */
export function restoreBuiltinPersona(
	ai: AISettingsDraft,
	presetId: string,
): { ai: AISettingsDraft; railId: string } {
	const railId = `${PRESET_RAIL_PREFIX}${presetId}`;
	const removed = ai.removedBuiltinPresets;
	if (!removed?.includes(presetId)) return { ai, railId };
	const left = removed.filter((id) => id !== presetId);
	if (left.length > 0) return { ai: { ...ai, removedBuiltinPresets: left }, railId };
	// 拿空了 = 一份没删 = 不记这一格(缺这一格的草稿与基线一比就是显式删键)
	const { removedBuiltinPresets: _gone, ...rest } = ai;
	return { ai: rest, railId };
}

/**
 * 「从内置修改」——以某一份为蓝本另存一份**可改**的。
 *
 * 抄的是**左栏里那一份**的当下内容(内置的取当前语言)。新 id 走 `persona-N`,
 * 它从此是主人自己的:不再是内置、不受只读闸限制、也不再跟着语言变。
 */
export function duplicatePersona(
	ai: AISettingsDraft,
	builtins: Builtins,
	railId: string,
): { ai: AISettingsDraft; railId: string } {
	const i = railIndex(ai, builtins, railId);
	const src = i >= 0 ? railPresets(ai, builtins)[i] : undefined;
	if (!src) return { ai, railId };

	const id = freshPersonaId(ai);
	const copy: AIPreset = { ...clonePreset(src), id, label: `${src.label || "未命名"} 副本` };
	return {
		ai: { ...ai, presets: [...ai.presets, copy] },
		railId: `${PRESET_RAIL_PREFIX}${id}`,
	};
}
