/**
 * AI 设置页两个左栏的增删操作 —— 对 `AISettings` 草稿的纯变换,一律返回新对象。
 *
 * 抽出来是因为这里的分支最容易悄悄错、又最难在界面上看出来:删掉正在用的那份之后
 * 指针指向哪、删到一份不剩会不会炸、新实例 / 新人格的 id 撞没撞上。
 */

import {
	AI_PROVIDER_IDS,
	type AIProviderId,
	BUILTIN_AI_PRESETS,
	EMPTY_AI_PROVIDER_PROFILE,
	providerMeta,
} from "@bilibili-notify/internal/constants";
import type { AIPersona, AISettings } from "../../types/globals";

type AIPreset = AISettings["presets"][number];

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
function railOrder(ai: AISettings): string[] {
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

export function profileRailItems(ai: AISettings): ProfileRailItem[] {
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
export function addProfile(ai: AISettings, provider: AIProviderId): { ai: AISettings; id: string } {
	const taken = new Set(Object.keys(ai.providers));
	let id: string = provider;
	let n = 1;
	while (taken.has(id)) {
		n += 1;
		id = `${provider}-${n}`;
	}
	const sameFamily = Object.values(ai.providers).some((p) => p?.provider === provider);
	const label = sameFamily ? `${providerMeta(provider).label} ${n}` : "";
	const pointerLanded = ai.providers[ai.activeProfile] !== undefined;
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
export function setActiveProfile(ai: AISettings, id: string): AISettings {
	if (ai.providers[id] === undefined) return ai;
	return { ...ai, activeProfile: id };
}

/** 给实例改显示名。清空 = 回落到注册表里那家的名字(见 {@link profileRailItems})。 */
export function renameProfile(ai: AISettings, id: string, label: string): AISettings {
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
export function resolveEditingProfile(ai: AISettings, id: string | null): string | null {
	if (id !== null && ai.providers[id] !== undefined) return id;
	if (ai.providers[ai.activeProfile] !== undefined) return ai.activeProfile;
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
export function removeProfile(ai: AISettings, id: string): AISettings {
	if (ai.providers[id] === undefined) return ai;
	// 用「浅拷贝 + delete」而非计算键 rest 解构:后者会让 TS 把 rest 推成 `{}`,
	// 之后按字符串索引就报隐式 any。
	const rest: AISettings["providers"] = { ...ai.providers };
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
// 人格只住在 `presets[]` 里,`activePreset` 指着全局当前用的那一份。曾经这里还有个
// 「默认」项对应 `ai.persona` —— 但 `DEFAULT_AI.persona` 与 `presets[0]`「温柔女仆」
// 本就是同一份(见 globals.ts「默认配置 = 首个预设,单一真相」),摆两个入口是重复,
// 还得解释哪个才算数。schema 那边的迁移保证:`presets` 恒非空、指针恒有着落。

/** 左栏 id = `preset:<id>`。留前缀是为了与将来可能出现的别种行天然分开命名空间。 */
const PRESET_RAIL_PREFIX = "preset:";

export interface PersonaRailItem {
	/** 左栏 id(带前缀)。 */
	id: string;
	/** 原始 preset id。调用方拿它查图标之类,免得在组件里切字符串。 */
	presetId: string;
	label: string;
}

export function personaRailItems(ai: AISettings): PersonaRailItem[] {
	return ai.presets.map((p) => ({
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

/** 左栏 id → presets[] 下标。不是预设、或该预设已不存在时返回 -1。 */
function presetIndex(ai: AISettings, railId: string): number {
	if (!railId.startsWith(PRESET_RAIL_PREFIX)) return -1;
	const id = railId.slice(PRESET_RAIL_PREFIX.length);
	return ai.presets.findIndex((p) => p.id === id);
}

/**
 * 把左栏选中项收敛到一个**真实存在**的 id。
 *
 * 选中项可能凭空消失(刚被删掉、备份导入换了一批)。不收敛的话左栏没有任何一项高亮、
 * 右侧却显示着别的内容 —— 高亮项与内容各说各话。
 */
export function resolvePersonaRailId(ai: AISettings, railId: string): string {
	if (presetIndex(ai, railId) >= 0) return railId;
	const first = ai.presets[0];
	return first ? `${PRESET_RAIL_PREFIX}${first.id}` : "";
}

/**
 * 取出当前该显示在右侧的那一份。
 *
 * 两段 prompt 是 optional,`undefined` = 用全局那份(见 `resolve()` 的 `??` 链),
 * 这里**照实显示为空**而不是把全局文案搬过来充数 —— 后者一保存就把「跟随」坐实成
 * 一份副本,此后改全局再也带不动它,而界面上完全看不出发生了这件事。
 */
export function personaAt(ai: AISettings, railId: string): PersonaDraft {
	const i = presetIndex(ai, resolvePersonaRailId(ai, railId));
	const preset = i >= 0 ? ai.presets[i] : undefined;
	if (!preset) {
		return {
			persona: ai.persona,
			dynamicPrompt: ai.dynamicPrompt,
			liveSummaryPrompt: ai.liveSummaryPrompt,
		};
	}
	return {
		persona: preset.persona,
		dynamicPrompt: preset.dynamicPrompt ?? "",
		liveSummaryPrompt: preset.liveSummaryPrompt ?? "",
	};
}

/**
 * 把一次编辑写回对应的那一份。
 *
 * 两段 prompt 走一道转换:**清空 → `undefined`**,也就是恢复「用全局那份」。存成 `""`
 * 的话 `resolve()` 里的 `??` 链不会再落到全局(空串不是 nullish),该预设从此强制发
 * 一段**空** prompt —— 主人看到的是输入框空着,实际效果却截然不同。
 */
export function updatePersonaAt(
	ai: AISettings,
	railId: string,
	patch: Partial<PersonaDraft>,
): AISettings {
	const i = presetIndex(ai, resolvePersonaRailId(ai, railId));
	// 内置那几份是只读的参照库。界面上字段已经禁掉,这里是第二道闸 —— 一处漏了
	// 另一处还拦得住,而「内置被改花了」是不可逆的(此后无从恢复)。
	if (i < 0 || isBuiltinPersona(ai.presets[i]?.id ?? "")) return ai;
	const blankToUndefined = (v: string): string | undefined => (v === "" ? undefined : v);
	const presets = ai.presets.map((p, idx) => {
		if (idx !== i) return p;
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

/**
 * 添加一份空白人格,并把它的左栏 id 交回调用方(好当场切过去)。
 *
 * id 逐个递增到不与**任何**已有 id 相撞为止。撞 id 的后果不是报错而是静默串台:
 * per-UP `overrides.ai.preset` 指着那个 id,`resolve()` 用 `find()` 取第一个匹配 ——
 * 两份同 id 的预设永远只有前一份生效,主人改后一份怎么改都不见效果。
 *
 * 两段 prompt 留 `undefined` = 一开始就用全局那份,而不是塞两段空串把它坐实。
 */
export function addPersona(ai: AISettings, label = "新性格"): { ai: AISettings; railId: string } {
	const taken = new Set(ai.presets.map((p) => p.id));
	let n = 1;
	while (taken.has(`persona-${n}`)) n += 1;
	const id = `persona-${n}`;
	return {
		ai: { ...ai, presets: [...ai.presets, { id, label, persona: { ...EMPTY_PERSONA } }] },
		railId: `${PRESET_RAIL_PREFIX}${id}`,
	};
}

/**
 * 删掉一份人格。
 *
 * **最后一份删不掉** —— AI 总得有一份人格,列表空了右侧就没东西可显示,而 `resolve()`
 * 只能回落到那份界面上已经没有入口的 `ai.persona`。删掉的正是全局用着的那份时,
 * 指针落到剩下的第一份(而不是变成悬空引用:那会跟着备份导出,日后又添加一份同 id
 * 的预设时莫名复活)。
 */
export function removePersona(ai: AISettings, railId: string): AISettings {
	const i = presetIndex(ai, railId);
	if (i < 0 || ai.presets.length <= 1) return ai;
	const presets = ai.presets.filter((_, idx) => idx !== i);
	const next: AISettings = { ...ai, presets };
	if (ai.activePreset !== undefined && ai.activePreset === ai.presets[i]?.id) {
		next.activePreset = presets[0]?.id;
	}
	return next;
}

/** 给人格改名。 */
export function renamePersona(ai: AISettings, railId: string, label: string): AISettings {
	const i = presetIndex(ai, railId);
	if (i < 0 || isBuiltinPersona(ai.presets[i]?.id ?? "")) return ai;
	return { ...ai, presets: ai.presets.map((p, idx) => (idx === i ? { ...p, label } : p)) };
}

/** 全局此刻用的是哪一份 —— 读 `ai.activePreset` 指针,换算成左栏 id。 */
export function globalPersonaRailId(ai: AISettings): string {
	return resolvePersonaRailId(ai, `${PRESET_RAIL_PREFIX}${ai.activePreset ?? ""}`);
}

/**
 * 「设为默认」——**改指针,不复制**。
 *
 * 旧界面靠「把预设复制进 `ai.persona`」来表达选中,那一下就把主人手写的全局人格盖掉
 * 且换不回来;想显示「现在选的是哪份」还得拿 persona 去逐字段比对猜。指针把两个毛病
 * 一并解决。
 */
export function setGlobalPersona(ai: AISettings, railId: string): AISettings {
	const i = presetIndex(ai, railId);
	if (i < 0) return ai;
	return { ...ai, activePreset: ai.presets[i]?.id };
}

// ── 内置人格:只读的参照库 ──────────────────────────────────────────────
//
// 内置那四份在界面上**锁死**:可以删、可以「从内置修改」另存一份可改的副本,但不能
// 就地改。理由很实在:「从内置恢复」要有个稳定的东西可恢复,内置被改花了这条路就断了。
// 判据是 **id** 而不是内容 —— 按内容判会出现「同样是傲娇毒舌,这份能改那份不能」。

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_AI_PRESETS.map((p) => p.id));

export function isBuiltinPersona(presetId: string): boolean {
	return BUILTIN_IDS.has(presetId);
}

/** 被删掉的内置人格 —— 「从内置恢复」列的就是这些。空数组 = 一份没删,入口收起来。 */
export function missingBuiltinPersonas(ai: AISettings): { id: string; label: string }[] {
	const have = new Set(ai.presets.map((p) => p.id));
	return BUILTIN_AI_PRESETS.filter((p) => !have.has(p.id)).map((p) => ({
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
 * 把某份内置人格加回清单。
 *
 * **插回它在内置清单里的原位**,而不是甩到末尾:内置那几份该始终保持注册表序,
 * 否则恢复一次清单就乱一次(自建的人格会夹在内置中间)。
 */
export function restoreBuiltinPersona(
	ai: AISettings,
	presetId: string,
): { ai: AISettings; railId: string } {
	const railId = `${PRESET_RAIL_PREFIX}${presetId}`;
	const src = BUILTIN_AI_PRESETS.find((p) => p.id === presetId);
	if (!src || ai.presets.some((p) => p.id === presetId)) return { ai, railId };

	const order = BUILTIN_AI_PRESETS.findIndex((p) => p.id === presetId);
	// 插在「注册表里排在它之后、且当前在清单里」的第一份之前;找不到就追加。
	const laterIds = new Set<string>(BUILTIN_AI_PRESETS.slice(order + 1).map((p) => p.id));
	let at = ai.presets.findIndex((p) => laterIds.has(p.id));
	if (at < 0) at = ai.presets.length;

	const presets = [...ai.presets];
	presets.splice(at, 0, clonePreset(src as unknown as AIPreset));
	return { ai: { ...ai, presets }, railId };
}

/**
 * 「从内置修改」——以某一份为蓝本另存一份**可改**的。
 *
 * 抄的是**清单里那一份**的当下内容(对未动过的内置来说就等于注册表那份)。
 * 新 id 走 `persona-N`,于是它不再是内置、也就不受只读闸限制。
 */
export function duplicatePersona(
	ai: AISettings,
	railId: string,
): { ai: AISettings; railId: string } {
	const i = presetIndex(ai, railId);
	const src = i >= 0 ? ai.presets[i] : undefined;
	if (!src) return { ai, railId };

	const taken = new Set(ai.presets.map((p) => p.id));
	let n = 1;
	while (taken.has(`persona-${n}`)) n += 1;
	const id = `persona-${n}`;
	const copy: AIPreset = { ...clonePreset(src), id, label: `${src.label || "未命名"} 副本` };
	return {
		ai: { ...ai, presets: [...ai.presets, copy] },
		railId: `${PRESET_RAIL_PREFIX}${id}`,
	};
}
