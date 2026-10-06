/**
 * 推送历史 `history/<日>.jsonl`:0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)
 * → 现在的行(`feature` / `messages[]` / `status` / `targetId`)。一项一项收进来(⑥c);从前是 schema 读时映射、
 * 盘上不重写,历史仓开机只认最新的形状。已经是现在形状的行、推不出「替谁发的」的坏行一个字节不动。
 *
 * 行级的变换都在 {@link migrateHistoryLine} 一个函数里、**一趟读写**:老 `source` 先翻成 0.x 的推送种类,
 * 再把推送种类那一格 `kind`(0.x 的八种名字)换成 `feature`(特性键,⑬f),最后把格改成现在的名字(⑱b:`ts` →
 * `createdAt`、`uid` / `extensionId` + `externalId` → `identity`、`unameSnapshot` → `nameSnapshot`、消息的 `retryOf` →
 * `repushOf`),键都留在原来的位置。补丁行也在这一趟里改写(`patch` → `rowId`、消息的 `retryOf` → `repushOf`)。
 *
 * 跟图有关的格(消息的 `imageRef` → `image`、行的 `uavatarSnapshot`、重推原件里的 `{ ref, mime, own? }`,⑳d)要读盘、
 * 复制进图库,不是纯函数,住在 `history-images.ts`;日文件与原件的逐文件改写在这里,和行级的形状改写**同一趟读写**
 * (先 `migrateHistoryLine` 逐行改形状,再交给 `images` 迁图格,一个文件只写一次)。
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	BILIBILI_SOURCE_KEY,
	type FeatureKey,
	type Identity,
	type Logger,
} from "@bilibili-notify/internal";
import { sweepHistoryRetention } from "../history/retention.js";
import { isPatchLine, listDayFiles } from "../history/store.js";
import { dataPath } from "../runtime/roots.js";
import {
	isPlainObject,
	listFiles,
	parseJsonLine,
	readJsonFile,
	rewriteJsonFile,
	rewriteJsonlFile,
} from "./files.js";
import type { HistoryImages } from "./history-images.js";
import type { ZeroPushKind } from "./zero-vocabulary.js";

/**
 * `live` 只当开播(老格式分不出周期复推),`live-summary`(词云 / 总结)归到下播。pushId 借行 id —— 老行本来
 * 就一行一次推送。
 */
const LEGACY_SOURCE_TO_KIND: Record<string, ZeroPushKind> = {
	dynamic: "dynamic",
	live: "live",
	sc: "sc",
	guard: "guard",
	"special-danmaku": "special-danmaku",
	"special-enter": "special-enter",
	"live-summary": "live-end",
};

/**
 * 0.x 的推送种类 → 特性键(⑬f)。一一对应:周期「正在直播」(`live-ongoing`)是 `liveStreaming`,开播(`live`)是
 * `liveStart`(0.x 的历史分不出补报与开播,迁过来都当开播)。`satisfies` 钉着 0.x 的种类一个不漏、值都是活的特性键。
 */
const ZERO_PUSH_KIND_TO_FEATURE = {
	dynamic: "post",
	live: "liveStart",
	"live-ongoing": "liveStreaming",
	"live-end": "liveEnd",
	guard: "membership",
	sc: "superchat",
	"special-danmaku": "specialDanmaku",
	"special-enter": "specialUserEnter",
} satisfies Record<ZeroPushKind, FeatureKey>;

/** 一行老历史 → 新形状(推送种类那一格还叫 `kind`);不是老行的原样回(同一个对象)。 */
export function migrateLegacyHistoryEntry(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const r = raw as Record<string, unknown>;
	if (!("source" in r) || "kind" in r) return raw;
	const result = r.result as { ok?: unknown; per?: unknown[] } | undefined;
	const per = result?.per?.[0] as { ok?: unknown; latencyMs?: unknown; err?: unknown } | undefined;
	const targetIds = Array.isArray(r.targetIds) ? r.targetIds : [];
	return {
		id: r.id,
		pushId: r.id,
		ts: r.ts,
		kind: LEGACY_SOURCE_TO_KIND[String(r.source)] ?? r.source,
		uid: r.uid,
		subscriptionId: r.subscriptionId,
		targetId: targetIds[0] ?? null,
		status: result?.ok === true ? "delivered" : "failed",
		messages: [
			{
				payload: r.payload,
				role: "main",
				result: per ? { ok: per.ok, latencyMs: per.latencyMs, err: per.err } : undefined,
			},
		],
		unameSnapshot: r.unameSnapshot,
	};
}

/**
 * 推送种类那一格 `kind`(0.x 的八种名字)→ `feature`(特性键),**键留在原来的位置**、别的格一个字不动。
 * 已经有 `feature` 的行、`kind` 不是那八种之一的行(历史仓照旧当坏行跳过)原样回(同一个对象)。
 */
function migrateKindToFeature(raw: unknown): unknown {
	if (!isPlainObject(raw) || "feature" in raw) return raw;
	const kind = raw.kind;
	if (typeof kind !== "string" || !Object.hasOwn(ZERO_PUSH_KIND_TO_FEATURE, kind)) return raw;
	const feature = ZERO_PUSH_KIND_TO_FEATURE[kind as ZeroPushKind];
	return Object.fromEntries(
		Object.entries(raw).map(([key, value]) =>
			key === "kind" ? ["feature", feature] : [key, value],
		),
	);
}

function isFilled(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/**
 * 老行「替谁发的」换算成身份:B 站行是 `uid`,拓展行是 `extensionId` + `externalId`。拓展那两格有一格就是拓展行,
 * 只按拓展那一支认 —— 缺了一格也不退去按 `uid` 认(与重推、面板回找订阅一直是一条规矩)。推不出回 `undefined`。
 */
function identityOfRow(row: Record<string, unknown>): Identity | undefined {
	const { uid, extensionId, externalId } = row;
	if (extensionId !== undefined || externalId !== undefined) {
		return isFilled(extensionId) && isFilled(externalId)
			? { sourceKey: extensionId, externalId }
			: undefined;
	}
	return isFilled(uid) ? { sourceKey: BILIBILI_SOURCE_KEY, externalId: uid } : undefined;
}

/** 消息里的 `retryOf` → `repushOf`,**键留在原来的位置**、别的格不动。行里的消息与补丁行里的消息共用。 */
function renameRepushOf(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;
	return messages.map((message: unknown) =>
		isPlainObject(message) && "retryOf" in message
			? Object.fromEntries(
					Object.entries(message).map(([key, value]) =>
						key === "retryOf" ? ["repushOf", value] : [key, value],
					),
				)
			: message,
	);
}

/**
 * ⑱b:一行里的格改成现在的名字,**键都留在原来的位置**、别的格一个字不动。身份的三个散格并成一格 `identity`,落在
 * 它们里头最先出现的那个位置上(B 站行是 `uid` 的位置,拓展行是 `extensionId` 的位置)。`identity` 由调用方换算好
 * 交进来(换算不出的行根本不会走到这里)。跟图有关的两格(`imageRef`、`uavatarSnapshot`)不在这里管,见 `history-images.ts`。
 */
function renameRowKeys(row: Record<string, unknown>, identity: Identity): Record<string, unknown> {
	let identityPlaced = false;
	const entries: [string, unknown][] = [];
	for (const [key, value] of Object.entries(row)) {
		switch (key) {
			case "ts":
				entries.push(["createdAt", value]);
				break;
			case "uid":
			case "extensionId":
			case "externalId":
				if (!identityPlaced) entries.push(["identity", identity]);
				identityPlaced = true;
				break;
			case "unameSnapshot":
				entries.push(["nameSnapshot", value]);
				break;
			case "messages":
				entries.push([key, renameRepushOf(value)]);
				break;
			default:
				entries.push([key, value]);
		}
	}
	return Object.fromEntries(entries);
}

/**
 * 老补丁行(⑱b 之前 `patch` 打头)的行首。现在的补丁行是 `rowId` 打头,历史仓认的是后者
 * (`isPatchLine`);这一个只有迁移器认。
 */
const LEGACY_PATCH_LINE_PREFIX = '{"patch":';

/** 老补丁行改写:`patch` → `rowId`(仍是第一个键)、消息的 `retryOf` → `repushOf`。读不懂的原样回。 */
function migrateLegacyPatchLine(line: string): string {
	const patch = parseJsonLine(line);
	if (!isPlainObject(patch) || typeof patch.patch !== "string") return line;
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(patch).map(([key, value]) => {
				if (key === "patch") return ["rowId", value];
				if (key === "messages") return [key, renameRepushOf(value)];
				return [key, value];
			}),
		),
	);
}

/**
 * 一行历史(jsonl 的一行原文)迁成最新形状:老 `source` → 0.x 的推送种类 → `feature`,再把格改成现在的名字;老补丁行
 * 的 `patch` → `rowId`。已经是现在形状的行(带 `identity`、`rowId` 打头的补丁行)、推不出「替谁发的」的坏行
 * (既没有 `uid`、也没有 `extensionId` + `externalId` 一对)、推送种类认不得的坏行、读不懂的行回原文(一个字节不动)。
 */
export function migrateHistoryLine(line: string): string {
	if (isPatchLine(line)) return line;
	if (line.startsWith(LEGACY_PATCH_LINE_PREFIX)) return migrateLegacyPatchLine(line);
	const row = parseJsonLine(line);
	if (!isPlainObject(row) || "identity" in row) return line;
	const identity = identityOfRow(row);
	if (identity === undefined) return line;
	// 前两步回的一定还是普通对象(要么原样,要么新造一个),所以这里的断言是实话。
	const translated = migrateKindToFeature(migrateLegacyHistoryEntry(row)) as Record<
		string,
		unknown
	>;
	// 推送种类认不得(`kind` 不是那八种之一),或者 `kind` 与 `feature` 并存:这一行是坏行,整行原样,改名也不碰它。
	if ("kind" in translated) return line;
	return JSON.stringify(renameRowKeys(translated, identity));
}

/**
 * ⑱c:一份重推原件(`history/repush/<日>/<行 id>.json`)的 `v` → `version`,**键留在原来的位置**、消息一个字不动。
 * 已经是 `version` 的、读不懂的回 `undefined`(不改写)。载荷种类的改名随活的载荷改名那一期(3a / 3b),不在这里。
 */
function migrateRepushSnapshot(value: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(value) || !("v" in value) || "version" in value) return undefined;
	return Object.fromEntries(
		Object.entries(value).map(([key, v]) => (key === "v" ? ["version", v] : [key, v])),
	);
}

export interface RepushSnapshotMigration {
	/** 改写过的原件(绝对路径)。 */
	rewritten: string[];
	/** 有图读不到、整份作废的原件(绝对路径;文件已经从新代里删了)。 */
	voided: string[];
}

/**
 * 新代里每份重推原件迁成最新的形状:`v` → `version`(⑱c),图格 `{ ref, mime, own? }` → 图库引用(⑳d,见
 * `history-images.ts`),**一份只写一次**。有一张图读不到的原件整份作废:从新代里删掉(搬位置时是复制,删的是新代
 * 这一个名字,第 0 代那份不动)。日目录里原件自己存的图不进新代(搬位置时就没搬),这里只认 `.json`。
 */
export async function migrateRepushSnapshotFiles(
	dataRoot: string,
	images: HistoryImages,
): Promise<RepushSnapshotMigration> {
	const root = dataPath(dataRoot, "history", "repush");
	let days: string[];
	try {
		days = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rewritten: [], voided: [] };
		throw err;
	}
	const done: RepushSnapshotMigration = { rewritten: [], voided: [] };
	for (const day of days) {
		for (const name of await listFiles(join(root, day), ".json")) {
			const path = join(root, day, name);
			const file = await readJsonFile(path);
			if (file.kind !== "ok" || !isPlainObject(file.value)) continue;
			const renamed = migrateRepushSnapshot(file.value);
			const converted = await images.rewriteSnapshot(day, renamed ?? file.value);
			if (converted === null) {
				await unlink(path);
				done.voided.push(path);
			} else if (renamed !== undefined || converted !== file.value) {
				await rewriteJsonFile(path, converted);
				done.rewritten.push(path);
			}
		}
	}
	return done;
}

/**
 * 新代里每个日文件迁成最新的形状,回改写过的文件(绝对路径):行级的形状改写(`migrateHistoryLine`)和图格的改写
 * (`images`,见 `history-images.ts`)同一趟读写,一个文件只写一次。迁移器那一步先跑一次清扫({@link sweepMigratedHistory})
 * 定好水位线,再调它 —— 图格怎么迁看日子在水位线的哪一边。
 */
export async function migrateHistoryDayFiles(
	dataRoot: string,
	images: HistoryImages,
): Promise<string[]> {
	const root = dataPath(dataRoot, "history");
	const rewritten: string[] = [];
	for (const name of (await listDayFiles(dataRoot)).sort()) {
		const path = join(root, name);
		const day = name.slice(0, 10);
		if (
			await rewriteJsonlFile(path, (lines) => images.rewriteDay(day, lines.map(migrateHistoryLine)))
		) {
			rewritten.push(path);
		}
	}
	return rewritten;
}

/** 迁移里那次清扫用的日志口:清不动就让迁移失败(下次开机重来),不留一个水位线说清过、东西却还在的新代。 */
const STRICT_LOGGER: Logger = {
	debug: () => {},
	info: () => {},
	warn: (message) => {
		throw new Error(message);
	},
	error: (message) => {
		throw new Error(message);
	},
};

export interface MigratedHistorySweep {
	/** 清完以后的水位线(UTC 日,含当天)。 */
	clearedThrough: string | undefined;
	/** 没带过来的重推原件是哪几天。 */
	snapshotDays: string[];
	/** 给迁移报告的话:按数量说,不逐个文件列。 */
	skipped: { path: string; reason: string }[];
}

/**
 * ⑲c:**先替主人跑一次清扫**(ADR-0022 决策 9 下 10-04 的 🔗)。和开机后的清扫是同一个函数、时钟注入 ——
 * 超期怎么算只写一份。照换算后的天数,过了保留期的重推原件整天目录从新代里删掉(删的是新代的那份,第 0 代那份不动)、
 * 水位线定好;文字一行不动。
 *
 * ⑳d 起清扫不碰图:`history/img/` 不进新代,保留期内的行引用的图由 `history-images.ts` 逐张复制进图库,过了保留期的
 * 与孤儿图根本不读。先于日文件的改写调它 —— 图格怎么迁要看日子在水位线的哪一边,而水位线只由「此刻」与保留天数
 * 定,不依赖行的形状。
 */
export async function sweepMigratedHistory(opts: {
	dataRoot: string;
	retentionDays: number;
	now: Date;
}): Promise<MigratedHistorySweep> {
	const swept = await sweepHistoryRetention({ ...opts, logger: STRICT_LOGGER });
	const skipped: MigratedHistorySweep["skipped"] = [];
	if (swept.snapshotDays.length > 0) {
		skipped.push({
			path: "history/repush",
			reason: `${swept.snapshotDays.length} 天的重推原件过了保留期(${opts.retentionDays} 天),没带过来`,
		});
	}
	return { clearedThrough: swept.clearedThrough, snapshotDays: swept.snapshotDays, skipped };
}
