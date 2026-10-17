import type { ConnectionView, GlobalConfigView } from "@bilibili-notify/contract";
import {
	type Connection,
	type GlobalConfig,
	GlobalConfigSchema,
	type MapMarkedHandlers,
	mapMarked,
	maskCell,
} from "@bilibili-notify/internal";
import {
	resolveSettings,
	type SecretCellsReader,
	secretsUnaskable,
} from "../push/connection-settings.js";

/**
 * 下发给浏览器前把密钥格换成 {@link MaskedSecret}(ADR-0021 决策 44)。判据是 schema 上的 `secret` 标记
 * (`markSecret`),按值走 schema —— 不按键名猜,新字段标了就跟着遮。
 *
 * 只遮 `secret` 那一档:`backupOnly`(OneBot 地址、AI baseUrl、请求头的值)面板照常显示。空串 / 没配
 * 照旧(`maskCell` 保证),面板要分得开「没配」与「配了」。
 */
const MASK_SECRETS: MapMarkedHandlers = {
	onMark: (value, mark) => ("secret" in mark ? maskCell(value) : value),
	onUntyped: (value) => value,
};

/**
 * 连接的 `settings` 下发时的打码走法 —— 与 {@link MASK_SECRETS} 的差别只有一处:**schema 管不到的从严**。
 * 连接外壳里 `settings` 是 `z.unknown()`,真正的规则在适配器手上;管不到的片(没声明的键、对不上任何一支的值)
 * 宁可多遮也不原样出门。
 */
const MASK_SETTINGS: MapMarkedHandlers = {
	onMark: (value, mark) => ("secret" in mark ? maskCell(value) : value),
	onUntyped: (value) => maskCell(value),
};

/**
 * 键名在 `keys` 里的那一格换成遮挡(递归走普通对象与数组,任意深度)。拓展在字段表 / 清单里声明成密钥的键
 * 走这里 —— 拓展的 schema 上没有 `secret` 标记。与备份脱敏那边按键名、任意深度的走法一致。
 */
function maskDeclared(value: unknown, keys: ReadonlySet<string>): unknown {
	if (Array.isArray(value)) return value.map((item) => maskDeclared(item, keys));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [k, keys.has(k) ? maskCell(v) : maskDeclared(v, keys)]),
	);
}

/**
 * 一条连接下发时的样子。**`settings` 的规则归适配器**,所以按在场的适配器分三种(整格遮挡的两种里
 * 一个字都不出门):
 * ① 适配器不在场 → 整格 `{ masked }`(宿主分不出哪一格是密钥);
 * ② 在场但设置过不了它的 `settingsSchema` → 整格 `{ masked }`,另带逐条原因 `settingsIssues`
 *    (解不过的值走标记会在联合那一层落成「管不到」,认不出任何一格,只能整格);
 * ②′ 拓展(非内置)在场、合法,但声明的密钥键问不出来({@link secretsUnaskable})→ 整格 `{ masked }`;
 * ③ 在场且合法 → 解过的值,`secret` 标记的格遮挡,再按拓展声明的密钥键补遮;管不到的从严遮挡。
 *
 * ⚠️ 不能照 {@link globalConfigView} 的写法拿外壳 schema 走:外壳的 `settings` 是 `z.unknown()`,
 * 会整份落进 `onUntyped`;那里若是「原样」,整份 `settings` 就明文下发了。
 */
export function connectionView(connection: Connection, lookup: SecretCellsReader): ConnectionView {
	const schema = lookup.settingsSchemaOf(connection.adapterKey);
	if (!schema) return { ...connection, settings: maskCell(connection.settings) };
	const resolved = resolveSettings(schema, connection.settings);
	if (!resolved.ok) {
		return {
			...connection,
			settings: maskCell(connection.settings),
			settingsIssues: resolved.issues ?? [],
		};
	}
	// 拓展在场但声明的密钥键问不出来:合法也整格遮挡(拓展的 schema 上没有标记)。
	if (secretsUnaskable(lookup, connection.adapterKey)) {
		return { ...connection, settings: maskCell(connection.settings) };
	}
	const declared = new Set(lookup.declaredSecretKeysOf(connection.adapterKey) ?? []);
	const marked = mapMarked(schema, resolved.settings, MASK_SETTINGS);
	return { ...connection, settings: declared.size > 0 ? maskDeclared(marked, declared) : marked };
}

/** 核心设置下发时的样子(AI 各实例的两把 key 与联网搜索 key 换成遮挡)。 */
export function globalConfigView(globals: GlobalConfig): GlobalConfigView {
	return mapMarked(GlobalConfigSchema, globals, MASK_SECRETS) as GlobalConfigView;
}

/**
 * 内置集成登记段的设置:按该段 schema 上的 `secret` 标记遮,打码走法同核心设置({@link MASK_SECRETS})。
 * 今天只有「日志按值打码」读它(`runtime/settings-redaction.ts`,由入口注入);面板的 `/api/settings`
 * 还原样下发集成设置,等内置适配器登段(3b-41)时一并改。
 */
export function integrationSettingsView(schema: unknown, settings: unknown): unknown {
	return mapMarked(schema, settings, MASK_SECRETS);
}
