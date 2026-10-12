/**
 * 连接表单里的**凭据格**(ADR-0021 决策 44):`GET /api/connections` 下发时这几格是 `{ masked }`,
 * 浏览器手里没有全文。这个模块管三件事:
 * - 把下发的视图变成表单读得懂的 {@link DisplayConnection}(遮挡换成它的那串字);
 * - 编辑一条已存着的连接时,哪些凭据格「已存着」、点了「换一份」没有;
 * - 编辑存盘走 `PATCH /api/connections/:id`:**没动过的凭据格不进 PATCH**(带遮挡是 400,不带 = 保留),
 *   换了新的发新明文,点「换一份」后留空 = 清空(可选的格交 `null`、必填的格交空串)。
 *
 * 表单草稿里的凭据格从不放遮挡对象:已存着的在打开编辑时先清成空,「已存着」的信息另放(`savedMasks`)。
 *
 * 🔴 **`settings` 整格是遮挡时**(适配器没在跑 / 设置不合法,服务端下发整格一个 `{ masked }`):
 * 浏览器分不出哪一格是凭据,这里一格都不展开、不往里加键 —— 加了键就不再是遮挡的形状,
 * 等于绕过服务端「拒收遮挡值」的那道检查。{@link settingsAreMasked} 是这个判断的唯一出处。
 */

import type { ConnectionView } from "@bilibili-notify/contract";
import type { Connection, NewConnection } from "@bilibili-notify/internal";
import { buildPatch, isMaskedCell } from "@bilibili-notify/internal/patch";
import { maskedOf } from "@bilibili-notify/ui";

interface CredentialCell {
	/** `settings` 里的键。 */
	key: string;
	/** 字段表里那一栏的 code(`connection-fields.ts`)。 */
	code: string;
	/** 可选的格清空交 `null`(服务端删键),必填的交空串。 */
	optional: boolean;
}

/** 列表与表单用的连接:下发的视图把凭据格的遮挡换成了字,另带服务端报的设置问题。 */
export type DisplayConnection = Connection & Pick<ConnectionView, "settingsIssues">;

/**
 * 这条连接的 `settings` 是不是整格被遮住了(适配器没在跑 / 设置不合法)。
 * 是 = 设置那一节不画表单、不展开、不进 PATCH。
 */
export function settingsAreMasked(connection: Pick<NewConnection, "settings">): boolean {
	return isMaskedCell(connection.settings);
}

/** 这条连接有哪几个凭据格 —— 与 schema 上的 `secret` 标记对齐(OneBot token、webhook 地址与 secret、官机 appSecret)。 */
export function credentialCellsOf(
	connection: Pick<NewConnection, "adapterKey" | "settings">,
): readonly CredentialCell[] {
	if (settingsAreMasked(connection)) return [];
	switch (connection.adapterKey) {
		case "webhook":
			return [
				{ key: "url", code: "settings.url", optional: false },
				{ key: "secret", code: "settings.secret", optional: true },
			];
		case "onebot":
			return [{ key: "accessToken", code: "settings.accessToken", optional: true }];
		case "qq-official":
			return [{ key: "appSecret", code: "settings.appSecret", optional: false }];
		default:
			return [];
	}
}

type Bag = Record<string, unknown>;

const settingsOf = (connection: Pick<NewConnection, "settings">): Bag => connection.settings as Bag;
const withSettings = <T extends NewConnection>(connection: T, settings: Bag): T => ({
	...connection,
	settings,
});

/**
 * 下发的视图 → 表单与列表用的连接:凭据格里的遮挡换成它那串字(列表行显示用,**不会写回**)。
 * 整格遮挡的、没有凭据格的(拓展连接)原样。
 */
export function displayConnection(view: ConnectionView): DisplayConnection {
	const display = view as DisplayConnection;
	const cells = credentialCellsOf(display);
	if (cells.length === 0) return display;
	const settings: Bag = { ...settingsOf(display) };
	for (const cell of cells) {
		if (!Object.hasOwn(settings, cell.key)) continue;
		const mask = maskedOf(settings[cell.key]);
		settings[cell.key] = mask === undefined ? settings[cell.key] : mask;
	}
	return withSettings(display, settings);
}

/** 编辑一条已存着的连接:哪些凭据格已配了(有值),值是服务端算好的遮挡串。按字段 code 索引。 */
export function savedMasksOf(display: NewConnection): Record<string, string> {
	const out: Record<string, string> = {};
	for (const cell of credentialCellsOf(display)) {
		const value = settingsOf(display)[cell.key];
		if (typeof value === "string" && value !== "") out[cell.code] = value;
	}
	return out;
}

/** 打开编辑时的草稿:凭据格先清空(已存着的由 `savedMasks` 记着,不进草稿)。 */
export function clearedCredentials<T extends NewConnection>(display: T): T {
	const cells = credentialCellsOf(display);
	if (cells.length === 0) return display;
	const settings: Bag = { ...settingsOf(display) };
	for (const cell of cells) {
		if (cell.optional) delete settings[cell.key];
		else settings[cell.key] = "";
	}
	return withSettings(display, settings);
}

function without<T extends NewConnection>(connection: T, keys: readonly string[]): T {
	if (keys.length === 0) return connection;
	const settings: Bag = { ...settingsOf(connection) };
	for (const key of keys) delete settings[key];
	return withSettings(connection, settings);
}

/**
 * 编辑存盘的 PATCH 体。`base` 是列表里那条(凭据格是遮挡串),`draft` 是表单草稿,`replacing` 记着
 * 哪几栏点了「换一份」。
 *
 * - 已存着且没点「换一份」→ 这一格不进 PATCH;
 * - 点了「换一份」→ 新明文;留空 = 清空(可选的 `null`、必填的空串);
 * - 本来就没配的 → 填了就发,没填就不提。
 * 其余格交给 `buildPatch(草稿, 基线)`:消失的键(切 OneBot 连法时上一档的残字段)变成显式 `null`,
 * `.strict()` 才过得去。
 *
 * `settings` 整格是遮挡的连接:PATCH 里**不带 `settings`**(只剩名字与开关的改动)。
 */
export function connectionPatch(
	draft: NewConnection,
	base: NewConnection,
	savedMasks: Record<string, string>,
	replacing: Record<string, boolean>,
): Record<string, unknown> {
	const cells = credentialCellsOf(draft);
	const kept = cells.filter((c) => savedMasks[c.code] !== undefined && replacing[c.code] !== true);
	const patch = buildPatch(
		without(
			draft,
			kept.map((c) => c.key),
		),
		without(
			base,
			credentialCellsOf(base).map((c) => c.key),
		),
	) as Record<string, unknown>;
	// 宿主独写 / 只读的几格不进 PATCH(服务端本来也忽略它们)。
	delete patch.platformSnapshot;
	delete patch.probeState;
	delete patch.settingsIssues;
	if (settingsAreMasked(base)) {
		delete patch.settings;
		return patch;
	}
	const settings = (patch.settings ?? {}) as Bag;
	for (const cell of cells) {
		if (savedMasks[cell.code] === undefined || replacing[cell.code] !== true) continue;
		const value = settingsOf(draft)[cell.key];
		settings[cell.key] =
			typeof value === "string" && value !== "" ? value : cell.optional ? null : "";
	}
	if (cells.length > 0) patch.settings = settings;
	return patch;
}
