/**
 * 连接表单里的**凭据格**(ADR-0021 决策 44):`GET /api/connections` 下发时这几格是 `{ masked }`,
 * 浏览器手里没有全文。这个模块管三件事:
 * - 把下发的视图变成表单读得懂的 {@link Connection}(遮挡换成它的那串字);
 * - 编辑一条已存着的连接时,哪些凭据格「已存着」、点了「换一份」没有;
 * - 编辑存盘走 `PATCH /api/connections/:id`:**没动过的凭据格不进 PATCH**(带遮挡是 400,不带 = 保留),
 *   换了新的发新明文,点「换一份」后留空 = 清空(可选的格交 `null`、必填的格交空串)。
 *
 * 表单草稿里的凭据格从不放遮挡对象:已存着的在打开编辑时先清成空,「已存着」的信息另放(`savedMasks`)。
 */

import type { ConnectionView } from "@bilibili-notify/contract";
import type { Connection } from "@bilibili-notify/internal";
import { buildPatch } from "@bilibili-notify/internal/patch";
import { maskedOf } from "../components/secret-cell";

interface CredentialCell {
	/** `config` 里的键。 */
	key: string;
	/** 字段表里那一栏的 code(`connection-fields.ts`)。 */
	code: string;
	/** 可选的格清空交 `null`(服务端删键),必填的交空串。 */
	optional: boolean;
}

/** 这条连接有哪几个凭据格 —— 与 schema 上的 `secret` 标记对齐(OneBot token、webhook 地址与 secret、官机 appSecret)。 */
export function credentialCellsOf(connection: Connection): readonly CredentialCell[] {
	if (connection.kind !== "direct") return [];
	if (connection.connector === "webhook") {
		return [
			{ key: "url", code: "config.url", optional: false },
			{ key: "secret", code: "config.secret", optional: true },
		];
	}
	if (connection.platform === "onebot") {
		return [{ key: "accessToken", code: "config.accessToken", optional: true }];
	}
	if (connection.platform === "qq-official") {
		return [{ key: "appSecret", code: "config.appSecret", optional: false }];
	}
	return [];
}

type Bag = Record<string, unknown>;

const configOf = (connection: Connection): Bag => connection.config as Bag;
const withConfig = (connection: Connection, config: Bag): Connection =>
	({ ...connection, config }) as Connection;

/**
 * 下发的视图 → 表单与列表用的连接:凭据格里的遮挡换成它那串字(列表行显示用,**不会写回**)。
 * 拓展连接那一支本片不打码,原样。
 */
export function displayConnection(view: ConnectionView): Connection {
	const asConnection = view as unknown as Connection;
	const config: Bag = { ...configOf(asConnection) };
	for (const cell of credentialCellsOf(asConnection)) {
		if (!Object.hasOwn(config, cell.key)) continue;
		const mask = maskedOf(config[cell.key]);
		config[cell.key] = mask === undefined ? config[cell.key] : mask;
	}
	return withConfig(asConnection, config);
}

/** 编辑一条已存着的连接:哪些凭据格已配了(有值),值是服务端算好的遮挡串。按字段 code 索引。 */
export function savedMasksOf(display: Connection): Record<string, string> {
	const out: Record<string, string> = {};
	for (const cell of credentialCells(display)) {
		const value = configOf(display)[cell.key];
		if (typeof value === "string" && value !== "") out[cell.code] = value;
	}
	return out;
}

const credentialCells = credentialCellsOf;

/** 打开编辑时的草稿:凭据格先清空(已存着的由 `savedMasks` 记着,不进草稿)。 */
export function clearedCredentials(display: Connection): Connection {
	const config: Bag = { ...configOf(display) };
	for (const cell of credentialCells(display)) {
		if (cell.optional) delete config[cell.key];
		else config[cell.key] = "";
	}
	return withConfig(display, config);
}

function without(connection: Connection, keys: readonly string[]): Connection {
	const config: Bag = { ...configOf(connection) };
	for (const key of keys) delete config[key];
	return withConfig(connection, config);
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
 */
export function connectionPatch(
	draft: Connection,
	base: Connection,
	savedMasks: Record<string, string>,
	replacing: Record<string, boolean>,
): Record<string, unknown> {
	const cells = credentialCells(draft);
	const kept = cells.filter((c) => savedMasks[c.code] !== undefined && replacing[c.code] !== true);
	const patch = buildPatch(
		without(
			draft,
			kept.map((c) => c.key),
		),
		without(
			base,
			credentialCells(base).map((c) => c.key),
		),
	) as Record<string, unknown>;
	const config = (patch.config ?? {}) as Bag;
	for (const cell of cells) {
		if (savedMasks[cell.code] === undefined || replacing[cell.code] !== true) continue;
		const value = configOf(draft)[cell.key];
		config[cell.key] =
			typeof value === "string" && value !== "" ? value : cell.optional ? null : "";
	}
	if (cells.length > 0) patch.config = config;
	return patch;
}
