import {
	GlobalConfigSchema,
	mapMarked,
	REDACTED_URL_HOST,
	type SecretMark,
} from "@bilibili-notify/internal";
import type { z } from "zod";
import {
	resolveSettings,
	type SecretCellsReader,
	secretsUnaskable,
} from "../push/connection-settings.js";

/**
 * 备份脱敏的核心:脱敏档与完整档的明文段都不许带任何凭据。
 *
 * **判据是 schema 上的标记**(`markSecret` / `markBackupOnly`,ADR-0021 决策 44):核心设置有 schema,
 * 连接的 `settings` 的 schema 在**适配器**手上(外壳里它是 `z.unknown()`,见 {@link redactConnections}),
 * 都拿 {@link mapMarked} 按值走,命中标记的叶子抹掉 —— 新加的字段叫什么名都一样,标了就抹。
 *
 * 标记管不到的地方照旧按**键名**猜(下面那份黑名单):别的几节本来就没有凭据字段、拓展那几格
 * (连接的 `settings` / 拓展自己的设置)的形状归拓展自己定,而 schema 里没声明的键、`z.unknown()` 的格也一样 ——
 * 宁可多抹,不留一个明文。黑名单同时是**守卫**:`backup-redaction-parity.test.ts` 钉住「键名
 * 在黑名单里的字符串叶子必须带标记」,换判据不许让被抹的叶子集合变一个。
 *
 * 两类凭据不是一个有自己名字的叶子,所以另有结构规则:叶子名由用户起的容器
 * ({@link SECRET_CONTAINER_KEYS} —— `headers`、`keys`)与藏在 URL 里的凭据({@link URL_KEYS})。
 * 前者在 schema 上是容器值类型上的标记,后者是带 `url` 位的标记。
 *
 * 抹成 `""` 而不是删键,对象保持原形 —— 脱敏档导进来仍然通过 schema,主人只需重填被抹的凭据。
 * 漏出去的是值,不是键。
 */

/** Key names whose values are credentials anywhere they appear in the config tree. */
export const SECRET_KEYS: readonly string[] = [
	"apiKey",
	"accessToken",
	"refreshToken",
	"appSecret",
	"secret",
	"token",
	"password",
];

/**
 * Key names whose values are **containers of credentials**: every leaf below
 * them is a secret regardless of its own key name. `ai.search.keys` is the
 * archetype — its leaves are named after backends (`bocha`/`tavily`), so the
 * per-key denylist above can never keep up as new backends land; the container
 * name is the stable signal.
 */
export const SECRET_CONTAINER_KEYS: readonly string[] = ["keys", "headers"];

/**
 * Key names whose values are URLs. A URL carries credentials in places the key
 * denylist structurally cannot see — `?access_token=` in the query, `user:pass@`
 * in the userinfo, and for 飞书 / 钉钉 style webhooks the token **is the path** —
 * so no part of a network URL can be assumed safe. The whole thing is replaced
 * by {@link REDACTED_URL}, keeping only the scheme so the sanitized config still
 * satisfies `z.url()` and OneBot's `wss?://` regex on import.
 */
export const URL_KEYS: readonly string[] = ["url", "baseUrl"];

/**
 * Schemes we know how to hand back as a valid placeholder. Anything else (a
 * `data:` URI, a relative path, the empty-string default on `ai.baseUrl`) is
 * left untouched — rewriting it would turn "not configured" into "configured
 * wrong", and none of them is an endpoint that can carry a bearer token.
 */
const PLACEHOLDER_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

const SECRET_KEY_SET = new Set<string>(SECRET_KEYS);
const SECRET_CONTAINER_SET = new Set<string>(SECRET_CONTAINER_KEYS);
const URL_KEY_SET = new Set<string>(URL_KEYS);

/**
 * Deep-clone `value`, replacing every leaf whose key is in {@link SECRET_KEYS}
 * with `""`. Does not mutate the input. Arrays and nested objects are walked.
 */
export function redactSecretKeys<T>(value: T, secrets: ReadonlySet<string> = SECRET_KEY_SET): T {
	return redact(value, secrets) as T;
}

/**
 * 拓展在字段表里声明成密钥(`secret: true`)的 config 键,**按拓展 id 分格**。
 *
 * 上面那份黑名单只认约定俗成的名字,而拓展的 config 形状归它自己定:叫 `botKey` 的密钥
 * 黑名单结构性地看不见,于是原样进备份文件 —— 而备份是主人会发出去求助的东西。
 * 所以密钥要**声明**出来,不能靠猜。
 *
 * 🔴 **分格是要紧的**:并成一份全局键名集合的话,一个拓展把 `name` 声明成密钥,备份里
 * 每一条连接与目标的 `name` 都会被抹成空串,而 `name` 是 `min(1)` —— 恢复时整份被拒。
 * 一个拓展声明的键只对**它自己那两格**生效:它那些连接的 `config`,与它自己那份 settings。
 *
 * 🔴 **不在表里 = 问不出来**:v1 拓展没跑起来(开关拨掉 / 连败停用)—— 它的字段表是**代码**
 * 在 `registerPushSource` 时交上来的;或者清单读不了 / 版本不合。v2 的声明住清单里
 * (ADR-0019 决策 17),跑没跑都问得出来。问不出来就把它的 config 与 settings **整片当密钥** —— 那两格
 * 本来就不由核心定形状(决策 19),分不出哪一格无辜。完整档照样原样恢复(真值在加密袋
 * 里,见 {@link collectRedactions});脱敏档丢的是本来就不该由我们替它担保的东西。
 *
 * 用 Map 不用普通对象:拿来查的 id 出自配置(连接的 `extensionId`、设置槽的键),普通对象按它取
 * 会顺着原型链摸 —— `{}["toString"]` 是个长度 0 的函数,被当成「一格都没声明」,那个拓展的密钥
 * 原样进备份;`{}["constructor"]` 则让导出直接炸。
 */
export type ExtensionSecretCodes = ReadonlyMap<string, readonly string[]>;

/** 备份分区里,拓展能插手的那一格。只写出用得上的形状。 */
interface ExtensionScopedSections {
	extensionSettings?: Record<string, unknown>;
}

/** 不给查表 = 一个适配器都问不出来:连接的 `settings` 一律整片抹空(最严的那一档)。 */
const NOTHING_KNOWN: SecretCellsReader = {
	settingsSchemaOf: () => undefined,
	declaredSecretKeysOf: () => undefined,
};

/**
 * 备份明文段的脱敏入口 —— 先全树走一遍键名黑名单(核心设置靠 schema 标记),连接的 `settings` 按
 * 在场适配器的 schema 与拓展声明的键抹,拓展设置按声明的键补一遍。
 *
 * 不改传进来的那份(第一步就深拷贝了)。
 */
export function redactBackupSections<T>(sections: T, lookup: SecretCellsReader = NOTHING_KNOWN): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
		if (key === "connections") out[key] = redactConnections(value, lookup);
		else {
			const schema = TYPED_SECTIONS[key];
			out[key] = schema ? redactByMarks(schema, value) : redact(value);
		}
	}
	redactExtensionScopes(out as ExtensionScopedSections, lookup);
	return out as T;
}

/** 有 schema 的一节:凭据靠标记。别的几节没有凭据字段,继续按键名;连接另走 {@link redactConnections}。 */
const TYPED_SECTIONS: Record<string, z.ZodType | undefined> = {
	globals: GlobalConfigSchema,
};

/** 命中标记的叶子抹成什么:网络地址换占位(要能恢复),其余抹成空串。 */
function eraseMarked(value: unknown, mark: SecretMark): unknown {
	return mark.url ? redactUrl(value, SECRET_KEY_SET) : blankLeaves(value);
}

function redactByMarks(schema: z.ZodType, value: unknown): unknown {
	return mapMarked(schema, value, {
		onMark: eraseMarked,
		// schema 管不到的:没声明的键带着键名走黑名单,其余整片走黑名单。
		onUntyped: (v, key) => {
			if (key === undefined) return redact(v);
			const wrapped = redact({ [key]: v }) as Record<string, unknown>;
			return wrapped[key];
		},
	});
}

/**
 * 连接这一节:**只动 `settings` 一格**(它的形状归适配器),别的格(外壳、平台快照、探测状态)里没有凭据,
 * 原样带着 —— 快照要「备份里带回」。`settings` 按两处问得出来的东西抹:适配器 `settingsSchema` 上的标记,
 * 与拓展声明的密钥键。
 *
 * - ① 两处都问不出来(适配器不在场、也没声明过)→ 整片抹空(沿用「问不出来整片当密钥」);
 * - ② 适配器在场但 `settings` 解不过它的规则(被隔离的连接)→ 整片抹空,从严;
 * - ②′ 拓展(非内置)的声明问不出来({@link secretsUnaskable},适配器在不在场都算)→ 整片抹空;
 * - ③ 其余 → 按标记抹(拓展的 schema 上没有标记,所以再整片过一遍键名黑名单与声明的键)。
 *
 * ③ 的输入是**盘上原文**(备份带的就是它,不补默认值)。被隔离的连接照样进备份:完整档里它的原值在
 * 加密袋里,恢复回来仍是那份不合法的原文、仍被隔离、主人看得见。
 */
function redactConnections(value: unknown, lookup: SecretCellsReader): unknown {
	if (!Array.isArray(value)) return redact(value);
	return value.map((entry) => {
		if (!isWalkable(entry)) return redact(entry);
		const out = structuredClone(entry);
		if (!Object.hasOwn(out, "settings")) return out;
		const adapterKey = typeof out.adapterKey === "string" ? out.adapterKey : "";
		out.settings = secretsUnaskable(lookup, adapterKey)
			? blankLeaves(out.settings)
			: redactSettings(
					out.settings,
					lookup.settingsSchemaOf(adapterKey),
					lookup.declaredSecretKeysOf(adapterKey),
				);
		return out;
	});
}

function redactSettings(
	settings: unknown,
	schema: z.ZodType | undefined,
	codes: readonly string[] | undefined,
): unknown {
	if (schema === undefined && codes === undefined) return blankLeaves(settings);
	if (schema !== undefined && !resolveSettings(schema, settings).ok) return blankLeaves(settings);
	const marked = schema === undefined ? settings : redactByMarks(schema, settings);
	return redact(marked, new Set([...SECRET_KEY_SET, ...(codes ?? [])]));
}

/** 就地把拓展那一格再抹一遍。入参是刚克隆出来的结果。 */
function redactExtensionScopes(sections: ExtensionScopedSections, lookup: SecretCellsReader): void {
	// 开关(`globals.extensions.<id>.enabled`)不是设置,不在这一节,不会被抹。
	const settings = sections.extensionSettings ?? {};
	for (const [id, value] of Object.entries(settings)) {
		if (value === undefined) continue;
		settings[id] = redactScoped(value, lookup.declaredSecretKeysOf(id));
	}
}

function redactScoped(value: unknown, codes: readonly string[] | undefined): unknown {
	// 问不出来 —— 整片当密钥,理由见 ExtensionSecretCodes。
	if (codes === undefined) return blankLeaves(value);
	// 跑着、但一格都没声明(字段表可以是空表)—— 基础那一遍已经走过了。
	if (codes.length === 0) return value;
	return redact(value, new Set([...SECRET_KEY_SET, ...codes]));
}

function redact(value: unknown, secrets: ReadonlySet<string> = SECRET_KEY_SET): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => redact(entry, secrets));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (secrets.has(key)) out[key] = "";
			else if (SECRET_CONTAINER_SET.has(key)) out[key] = blankLeaves(v);
			else if (URL_KEY_SET.has(key)) out[key] = redactUrl(v, secrets);
			else out[key] = redact(v, secrets);
		}
		return out;
	}
	return value;
}

/** Replace a network URL with a scheme-preserving placeholder. */
function redactUrl(value: unknown, secrets: ReadonlySet<string>): unknown {
	if (typeof value !== "string") return redact(value, secrets);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// 不是绝对 URL(默认空串、相对路径、占位文本)—— 原样留着。
		return value;
	}
	if (!PLACEHOLDER_SCHEMES.has(parsed.protocol)) return value;
	return `${parsed.protocol}//${REDACTED_URL_HOST}/`;
}

/** 明文段里被改掉的一处:到那个叶子的路径,以及它的原值。 */
export interface RedactedLeaf {
	path: ReadonlyArray<string | number>;
	value: unknown;
}

/**
 * 原件与脱敏后那份逐叶子比一遍,把**每一处被改掉的地方**连同原值收出来。
 *
 * 🔴 **这是完整档的不变式:凡是明文段被抹掉的,加密袋里都要有对应项。**
 *
 * 从前袋子是一份手抄清单(aiApiKeys / cookiesJson / refreshToken / connectionConfigs),
 * 而抹的那一侧是结构性的深度遍历 —— 两边必然漂,且漂了没有任何人会红:
 * `ai.providers.*.baseUrl` 与 `globals.marketplace.sources[*].url` 被抹成
 * `https://redacted.invalid/`、拓展 settings 里的 `token` 被抹成 `""`,袋子里一格都没有,
 * 于是**恢复之后那些配置全是占位符**(AI 打不通、市场源连不上、桥的接入全失效),而
 * 恢复流程一句话都不会说。以后再往脱敏那边加一条规则,这里自动跟上。
 */
export function collectRedactions(original: unknown, redacted: unknown): RedactedLeaf[] {
	const out: RedactedLeaf[] = [];
	diff(original, redacted, [], out);
	return out;
}

function diff(
	original: unknown,
	redacted: unknown,
	path: Array<string | number>,
	out: RedactedLeaf[],
): void {
	if (Array.isArray(original) && Array.isArray(redacted) && original.length === redacted.length) {
		for (const [i, entry] of original.entries()) diff(entry, redacted[i], [...path, i], out);
		return;
	}
	if (isWalkable(original) && isWalkable(redacted)) {
		for (const [key, value] of Object.entries(original)) {
			if (!(key in redacted)) {
				// 脱敏从不删键(它只把值换掉),所以这一支只可能是将来某条新规则 ——
				// 整格记下来,恢复时照样补得回去。
				out.push({ path: [...path, key], value });
				continue;
			}
			diff(value, redacted[key], [...path, key], out);
		}
		return;
	}
	// 形状对不上(整片被换掉)或标量变了 —— 记原值。
	if (!Object.is(original, redacted)) out.push({ path: [...path], value: original });
}

function isWalkable(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 把 {@link collectRedactions} 收出来的原值按路径填回去。就地改,返回同一个对象。 */
export function applyRedactions<T>(target: T, leaves: readonly RedactedLeaf[]): T {
	for (const leaf of leaves) {
		const last = leaf.path.at(-1);
		if (last === undefined) continue;
		let node: unknown = target;
		for (const segment of leaf.path.slice(0, -1)) {
			if (node === null || typeof node !== "object") break;
			node = (node as Record<string | number, unknown>)[segment];
		}
		// 路径上缺了一段 —— 那格在这份备份里本来就不存在,凭空造出来只会造出半个形状。
		if (node === null || typeof node !== "object") continue;
		(node as Record<string | number, unknown>)[last] = leaf.value;
	}
	return target;
}

/** Blank every leaf under a secret container, keeping the shape intact. */
function blankLeaves(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(blankLeaves);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) out[key] = blankLeaves(v);
		return out;
	}
	return "";
}
