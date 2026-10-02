/**
 * 订阅:0.x 的两份文件 `state/subscriptions.json`(B 站)与 `state/extension-subscriptions.json`(拓展)→ 新代
 * 里的一个 `config/subscriptions.json`,行行带 `identity`(ADR-0021 决策 14、15)。先把 0.x 各个版本留下的形状
 * 迁成 0.x 最新的形状(⑥c 收进来的),再换成 1.0 的形状;配置仓开机只认最新的形状。
 *
 * 每一行照 zod 当年跑 preprocess 的顺序改写:外层先跑,再跑里层 —— B 站那一行先整行迁
 * ({@link migrateLegacySubscription}:@全体 并进附加项、第一代 routing 时带 `force` 迁 features 覆盖),再迁
 * `routing`({@link migrateLegacyRouting})与 `overrides.features`(不带 `force` 的
 * {@link migrateLegacyFeatureFlagsPartial})。拓展订阅没有外层那一步。
 *
 * 迁成 0.x 最新形状的那一行再过一遍 1.0 的改名({@link renameSubscriptionKeys}:特性键、附加项键、文案键、版式键、
 * 顶层的 `extras` → `extraTargets`)与直播拆键({@link splitSubscriptionLiveSettings}:`routing.liveStreaming` 拷贝、
 * 覆盖里的 `pushTime` / `restartPush` 拆成开关、间隔与补报,要全局的值 —— 调用方递进来),然后才换身份 —— 这几步碰的是
 * 不相交的几格。
 *
 * 合好之后,0.x 每行的分组(一串名字 `groups`)换成一张标签表与各行的 `tagIds`(ADR-0034),
 * 新代里的文件是 `{ tags, subscriptions }`。
 */

import { join } from "node:path";
import { BILIBILI_SOURCE_KEY, deterministicUuid } from "@bilibili-notify/internal";
import { renameSubscriptionKeys } from "./feature-renames.js";
import {
	migrateLegacyFeatureFlagsPartial,
	migrateLegacyRouting,
	migrateLegacySubscription,
} from "./features.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";
import { type GlobalLiveFacts, splitSubscriptionLiveSettings } from "./live-split.js";

/** 两种订阅共有的那两格:`routing` 与 `overrides.features`。 */
function migrateSharedParts(row: unknown): unknown {
	if (!isPlainObject(row)) return row;
	let out = row;
	if (row.routing !== undefined) out = { ...out, routing: migrateLegacyRouting(row.routing) };
	const overrides = out.overrides;
	if (isPlainObject(overrides) && overrides.features !== undefined) {
		out = {
			...out,
			overrides: { ...overrides, features: migrateLegacyFeatureFlagsPartial(overrides.features) },
		};
	}
	return out;
}

/** B 站订阅的一行。 */
export function migrateBiliSubscriptionRow(raw: unknown): unknown {
	return migrateSharedParts(migrateLegacySubscription(raw));
}

/** 拓展订阅的一行。 */
export function migrateExtensionSubscriptionRow(raw: unknown): unknown {
	return migrateSharedParts(raw);
}

/**
 * 一行(已迁成 0.x 最新形状的)订阅 → 1.0 的形状:身份收进 `identity`(ADR-0021 决策 14),`kind` 与两支各自的
 * 身份格拿掉,主人起的别名 `name` 丢掉(别名退役,ADR-0021 决策 16:显示名只走资料名 → 身份标签)。`kind` 说的是
 * 它来自 0.x 的哪个文件。认不出身份的行原样留着,由配置仓开机时报出来。
 */
export function toIdentityRow(row: unknown, kind: "bilibili" | "extension"): unknown {
	if (!isPlainObject(row)) return row;
	if (kind === "bilibili") {
		const { kind: _kind, uid, name: _name, ...rest } = row;
		if (typeof uid !== "string") return row;
		return { id: rest.id, identity: { sourceKey: BILIBILI_SOURCE_KEY, externalId: uid }, ...rest };
	}
	const { kind: _kind, extensionId, externalId, name: _name, ...rest } = row;
	if (typeof extensionId !== "string" || typeof externalId !== "string") return row;
	return { id: rest.id, identity: { sourceKey: extensionId, externalId }, ...rest };
}

/** 0.x 一个分组名在 1.0 里成的标签名:去掉首尾空白,空的丢掉。 */
function tagNamesOf(raw: string): string[] {
	const name = raw.trim();
	return name ? [name] : [];
}

/** 0.x 一行订阅的分组里认得出的标签名,按行里的顺序(可能重复)。 */
function legacyTagNames(row: unknown): string[] {
	if (!isPlainObject(row) || !Array.isArray(row.groups)) return [];
	return row.groups.flatMap((g) => (typeof g === "string" ? tagNamesOf(g) : []));
}

/** 新代里的订阅文件(ADR-0034):标签表 + 订阅。 */
export interface SubscriptionFileValue {
	tags: Array<{ id: string; name: string }>;
	subscriptions: unknown[];
}

/**
 * 0.x 每行的分组 → 标签表 + 各行的 `tagIds`(ADR-0034)。同名的只成一个标签,按中文排序(和 0.x 订阅页筛选胶囊
 * 的排法一样,主人升上来看到的顺序不变);标签 id 由名字定(`deterministicUuid`),重迁拆出同一批 id。行里的
 * `groups` 在原位换成 `tagIds`,行内同名只挂一次;没有 `groups` 的行原样留着(schema 的默认值是空表)。
 */
export function toTaggedFile(rows: readonly unknown[]): SubscriptionFileValue {
	const names = [...new Set(rows.flatMap(legacyTagNames))].sort((a, b) =>
		a.localeCompare(b, "zh-Hans-CN"),
	);
	const tags = names.map((name) => ({ id: deterministicUuid(`subscription-tag:${name}`), name }));
	const idOf = new Map(tags.map((t) => [t.name, t.id]));
	const subscriptions = rows.map((row) => {
		if (!isPlainObject(row) || !("groups" in row)) return row;
		const tagIds = [...new Set(legacyTagNames(row).map((name) => idOf.get(name)))];
		return Object.fromEntries(
			Object.entries(row).map(([key, value]) =>
				key === "groups" ? ["tagIds", tagIds] : [key, value],
			),
		);
	});
	return { tags, subscriptions };
}

/** 一条 B 站订阅的订阅 id 与 uid:统计文件名与锐评草稿按 uid 找回订阅时用。 */
export interface BiliSubscriptionKey {
	id: string;
	uid: string;
}

/**
 * 新代里(已经迁好、合成一个文件的)B 站订阅,按文件里的顺序 —— 同一个 uid 订了几条时谁在前,和配置仓读出来的
 * 一样。文件不在当空表(全新安装,和配置仓同口径);读不懂、不是 `{ tags, subscriptions }` 回 `undefined`:配置仓开机时会拒收它,
 * 要它的那几步别在它上面改别的文件。
 */
export async function readBiliSubscriptionKeys(
	configDir: string,
): Promise<BiliSubscriptionKey[] | undefined> {
	const file = await readJsonFile(join(configDir, "subscriptions.json"));
	if (file.kind === "missing") return [];
	if (
		file.kind === "unreadable" ||
		!isPlainObject(file.value) ||
		!Array.isArray(file.value.subscriptions)
	) {
		return undefined;
	}
	return file.value.subscriptions.flatMap((row) =>
		isPlainObject(row) &&
		typeof row.id === "string" &&
		isPlainObject(row.identity) &&
		row.identity.sourceKey === BILIBILI_SOURCE_KEY &&
		typeof row.identity.externalId === "string"
			? [{ id: row.id, uid: row.identity.externalId }]
			: [],
	);
}

export interface MigrateSubscriptionFilesOptions {
	/** 新代的 `config/`:B 站订阅搬过来的 `subscriptions.json` 在这里,合好的也写回这里。 */
	configDir: string;
	/** 第 0 代的 `state/extension-subscriptions.json`:只作迁移输入,不进新代。 */
	extensionSubscriptionsPath: string;
	/** 直播拆键要的全局值(拆键之前的开播开关与 `pushTime`),见 `settings.ts` 的 `readZeroLiveFacts`。 */
	globalLive: GlobalLiveFacts;
}

/**
 * 两份订阅合成新代里的一个 `subscriptions.json`(ADR-0021 决策 15):各自迁成 0.x 最新的形状,再换成带
 * `identity` 的行,B 站的在前、拓展的在后(和配置仓从前拼两份的顺序一样),分组换成标签(ADR-0034),写成
 * `{ tags, subscriptions }`。回改写过的文件(绝对路径)。已经是这个形状的(迁过了)不再动。
 *
 * B 站那份读不懂、不是数组的原样留着,由配置仓开机时报出来。拓展那份不进新代,读不懂就**抛**:原样留着的话
 * 配置仓看不见它,拓展订阅会悄悄全丢;抛出去整代作废、下次开机重迁,主人看得到原因。
 */
export async function migrateSubscriptionFiles(
	opts: MigrateSubscriptionFilesOptions,
): Promise<string[]> {
	const path = join(opts.configDir, "subscriptions.json");
	const bili = await readJsonFile(path);
	const ext = await readJsonFile(opts.extensionSubscriptionsPath);
	if (ext.kind === "unreadable" || (ext.kind === "ok" && !Array.isArray(ext.value))) {
		throw new Error(
			"第 0 代的 state/extension-subscriptions.json 读不懂(不是 JSON 数组),拓展订阅没法迁过来",
		);
	}
	if (bili.kind === "unreadable" || (bili.kind === "ok" && !Array.isArray(bili.value))) return [];
	// 已经合过(行里有 `identity`,0.x 的文件里不会有):再合一遍会把拓展的订阅追加第二份。
	if (
		bili.kind === "ok" &&
		(bili.value as unknown[]).some((row) => isPlainObject(row) && "identity" in row)
	) {
		return [];
	}
	const extRows = ext.kind === "ok" ? (ext.value as unknown[]) : [];
	if (bili.kind === "missing" && extRows.length === 0) return [];
	const biliRows = bili.kind === "ok" ? (bili.value as unknown[]) : [];
	const toCurrent = (row: unknown): unknown =>
		splitSubscriptionLiveSettings(renameSubscriptionKeys(row), opts.globalLive);
	const next = toTaggedFile([
		...biliRows.map((row) => toIdentityRow(toCurrent(migrateBiliSubscriptionRow(row)), "bilibili")),
		...extRows.map((row) =>
			toIdentityRow(toCurrent(migrateExtensionSubscriptionRow(row)), "extension"),
		),
	]);
	await rewriteJsonFile(path, next, bili.kind === "ok" ? path : opts.extensionSubscriptionsPath);
	return [path];
}
