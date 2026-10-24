/**
 * AI 设置 `defaults.ai` 的 0.x 老形状:扁平的连接字段(→ `providers.custom`)、上一代「一家一桶」与
 * `provider` 指针(→ 实例桶 + `activeProfile`)、手改过的 `persona` 与预设上线前的 `presets: []`(→ 预设 +
 * `activePreset`)。⑥c 从 internal 的 `AISettingsSchema` preprocess 里原样收进来,三步的顺序不变。
 */

import { AI_PROVIDER_IDS } from "@bilibili-notify/internal";
import { builtinPresetsFor } from "@bilibili-notify/internal/builtin-texts";
import { DEFAULT_LOCALE } from "@bilibili-notify/internal/i18n";

const FACTORY_PRESETS = builtinPresetsFor(DEFAULT_LOCALE);

/**
 * 上一版的扁平连接字段。读老配置时整份搬进 `providers.custom`。
 *
 * 当年的扁平字段里还有 `temperature`,它已整个退役,所以不在这张表里:老配置残留的
 * 那个键留在 ai 这一层,被 {@link AISettingsObjectSchema} 剥掉(裸 z.object,不会整份
 * 拒收)。也不该让它单独撑起一个 custom 桶 —— 光有它不算「配过连接」。
 */
const LEGACY_FLAT_KEYS = [
	"apiKey",
	"baseUrl",
	"model",
	"enableThinking",
	"thinkingLevel",
	"extraParams",
	"enableVision",
	"vision",
] as const;

/**
 * 老配置迁移:一套扁平的连接字段 → `providers.custom`,并选中 `custom`。
 *
 * 落 `custom` 而不是按 baseUrl 认出那一家,是刻意的:兜底档不发任何方言参数,
 * 等价于分家这套东西上线之前的行为 —— **升级零行为变化**,也不必替主人猜。
 * 想用上思考功能的主人,自己去设置页添加那一家。
 *
 * 判据是「有没有 `providers` 键」而不是「有没有 apiKey」:后者会把一份还没填过
 * key 的新配置也当成老配置,平白造出一个空的 custom 桶,左栏就凭空多一块。
 */
export function migrateAiSettings(raw: unknown): unknown {
	if (raw === null || typeof raw !== "object") return raw;
	return migratePersonaPointer(
		migrateProviderInstances(migrateFlatProviderFields(raw as Record<string, unknown>)),
	);
}

function migrateFlatProviderFields(o: Record<string, unknown>): Record<string, unknown> {
	if (o.providers !== undefined) return o;

	const legacy: Record<string, unknown> = {};
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if ((LEGACY_FLAT_KEYS as readonly string[]).includes(k)) legacy[k] = v;
		else rest[k] = v;
	}
	// 一个字段都没有的话不造桶 —— 那是一份全新配置,左栏该是空的。
	if (Object.keys(legacy).length === 0) return { ...rest, providers: {} };
	return { ...rest, provider: "custom", providers: { custom: legacy } };
}

/**
 * 上一代「一家一桶」→ 当代「实例桶」:
 *
 * - 指针改名:`provider` → `activeProfile`(值原样 —— 老指针指的服务商名恰好
 *   就是迁移后那只桶的实例 id)。
 * - 桶盖章:键是认得的服务商名、桶里又没写 `provider` 的,按键名补上。键名
 *   **原样保留**:密钥加密袋的袋键就是桶键,搬键名等于重启后密钥对不上号。
 *
 * 认不出的键(不是服务商名、桶里也没写 provider)**不盖章**,留给 schema 拒收
 * —— 那是手改坏的数据,猜一个方言归属比报错更糟。
 */
function migrateProviderInstances(o: Record<string, unknown>): Record<string, unknown> {
	const out = { ...o };
	if (out.activeProfile === undefined && typeof out.provider === "string") {
		out.activeProfile = out.provider;
	}
	delete out.provider;

	const providers = out.providers;
	if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
		const next: Record<string, unknown> = { ...(providers as Record<string, unknown>) };
		for (const [key, bucket] of Object.entries(next)) {
			if (
				bucket !== null &&
				typeof bucket === "object" &&
				!Array.isArray(bucket) &&
				(bucket as Record<string, unknown>).provider === undefined &&
				(AI_PROVIDER_IDS as readonly string[]).includes(key)
			) {
				next[key] = { ...bucket, provider: key };
			}
		}
		out.providers = next;
	}
	return out;
}

/** 结构比较用。schema 全是纯数据,键序由 zod 定死,`JSON.stringify` 足够可靠。 */
function sameShape(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 人格只住在 `presets[]` 里,`activePreset` 指着当前那一份。
 *
 * `DEFAULT_AI.persona` 与 `presets[0]`「温柔女仆」本就是同一份(见 globals.ts 那句
 * 「默认配置 = 首个预设,单一真相」),所以设置页里再摆一个「默认」项是**重复** ——
 * 同一份东西两个入口,还得解释哪个才算数。删掉它之后就必须回答:**手改过
 * `ai.persona` 的老配置怎么办?** 不管的话那份人格数据还在盘上、界面上却再也点不到。
 *
 *   ① 已经有指针 → 不动(迁移只跑一次)
 *   ② `persona` 与某份预设逐字段相同 → 指向它,不造重复项
 *   ③ `persona` 是手改过的 → 造一份预设装着它并指过去,一个字都不丢
 *
 * 顺带守住一条不变量:`presets` 恒非空、`activePreset` 恒指向真实存在的项 ——
 * 「当前这份人格」永远有着落,消费方不必各自兜底。
 *
 * `ai.persona` 本身留着不删:它是 `resolve()` 在指针万一落空时的安全网,也让老版本
 * 读同一份配置文件时行为不变。界面上不再有任何入口编辑它。
 */
function migratePersonaPointer(o: Record<string, unknown>): Record<string, unknown> {
	const stored = Array.isArray(o.presets) ? (o.presets as Record<string, unknown>[]) : [];
	// `presets: []` 是预设功能上线**之前**写的 globals.json。这里补齐内置四份 ——
	// 而不是只拿 persona 派生一份出来:那样老用户会平白少掉三份内置人格。
	// (此前这件事由 ConfigStore 在加载后做,条件是 `presets.length === 0`;
	// 现在这道迁移必然把列表填成非空,那个条件再也不成立,所以责任移到这里。)
	const presets: Record<string, unknown>[] =
		stored.length > 0
			? [...stored]
			: (FACTORY_PRESETS as readonly unknown[]).map((p) => ({ ...(p as object) }));
	const persona = o.persona;

	if (typeof o.activePreset === "string") {
		// 指针已在。只兜一种坏情况:它指着一份不存在的预设(手改配置 / 备份换了一批)。
		if (presets.some((p) => p?.id === o.activePreset)) return o;
		if (presets.length > 0) return { ...o, activePreset: presets[0]?.id };
	}

	const matched = presets.find((p) => sameShape(p?.persona, persona));
	if (matched) return { ...o, presets, activePreset: matched.id };

	// 走到这里:persona 是手改过的(或 presets 干脆是空的)。给它造一份带得走的家。
	const name = (persona as { name?: unknown } | undefined)?.name;
	const label = typeof name === "string" && name.trim() ? name.trim() : "我的性格";
	const taken = new Set(presets.map((p) => p?.id));
	let id = "custom-persona";
	for (let n = 2; taken.has(id); n += 1) id = `custom-persona-${n}`;
	const mine: Record<string, unknown> = { id, label, persona };
	if (typeof o.dynamicPrompt === "string" && o.dynamicPrompt) mine.dynamicPrompt = o.dynamicPrompt;
	if (typeof o.liveSummaryPrompt === "string" && o.liveSummaryPrompt) {
		mine.liveSummaryPrompt = o.liveSummaryPrompt;
	}
	return { ...o, presets: [...presets, mine], activePreset: id };
}
