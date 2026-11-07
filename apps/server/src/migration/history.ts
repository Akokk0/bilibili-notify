import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { t as serverText } from "./i18n.js";
/**
 * 推送历史 `history/<日>.jsonl`:0.x 的老行(一行 = 一个目标 × 一条消息,带 `source` / `result` / `payload`)
 * → 现在的行(`feature` / `messages[]` / `status` / `targetId`)。一项一项收进来(⑥c);从前是 schema 读时映射、
 * 盘上不重写,历史仓开机只认最新的形状。已经是现在形状的行、推不出「替谁发的」的坏行一个字节不动。
 *
 * 行级的变换都在 {@link migrateHistoryLine} 一个函数里、**一趟读写**:老 `source` 先翻成 0.x 的推送种类,
 * 再把推送种类那一格 `kind`(0.x 的八种名字)换成 `feature`(特性键,⑬f),最后把格改成现在的名字(⑱b:`ts` →
 * `createdAt`、`uid` / `extensionId` + `externalId` → `identity`、`unameSnapshot` → `nameSnapshot`、消息的 `retryOf` →
 * `repushOf`),键都留在原来的位置。补丁行也在这一趟里改写(`patch` → `rowId`、消息的 `retryOf` → `repushOf`)。
 * 形状改完以后还有一步(3a-15):消息里老形状的失败结果 `{ ok: false, latencyMs, err? }` 改成结果形状
 * `{ ok: false, code: "unknown", message }`(ADR-0026 决策 5)。它对行与补丁行、老行与已经是现在形状的行都做。
 *
 * 跟图有关的格(消息的 `imageRef` → `image`、行的 `uavatarSnapshot`、重推原件里的 `{ ref, mime, own? }`,⑳d)要读盘、
 * 复制进图库,不是纯函数,住在 `history-images.ts`;日文件与原件的逐文件改写在这里,和行级的形状改写**同一趟读写**
 * (先 `migrateHistoryLine` 逐行改形状,再交给 `images` 迁图格,一个文件只写一次)。
 */

import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	type FeatureKey,
	fail,
	type Identity,
	type Logger,
	type NotificationPayload,
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
import type { ZeroPayloadKind, ZeroPushKind } from "./zero-vocabulary.js";

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
	"special-danmaku": "viewerChat",
	"special-enter": "viewerEnter",
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

/** 老失败没留原话时填的那一句。 */
const NO_REASON_MESSAGE = "没有送达，对端没说原因";

/**
 * 一条投递结果:老形状的失败(`ok: false`、没有 `code`)→ `{ ok: false, code: "unknown", message }`。原话抄 `err`,
 * 没有就填固定那句;耗时不留(失败那一支没有耗时)。**不按原话猜标准码** —— 猜错比「原因不明」更坏(ADR-0026)。
 * 送达的、已经是结果形状的、读不懂的原样回(同一个对象)。
 */
function migrateFailureResult(result: unknown): unknown {
	if (!isPlainObject(result) || result.ok !== false || "code" in result) return result;
	const message = isFilled(result.err) ? result.err : NO_REASON_MESSAGE;
	return fail("unknown", message);
}

/** 一行文字里有没有可能装着失败的结果。只拿来免掉送达行的那一趟解析,判定在 {@link migrateFailureResult}。 */
const FAILURE_HINT = /"ok"\s*:\s*false/;

/**
 * 3a-15:一行(或一条补丁行)里每条消息的老失败结果改成结果形状,`result` 留在消息里原来的位置、别的格不动。
 * 只对现在形状的行做(带 `identity` 的行、`rowId` 打头的补丁行 —— 老行先由前面几步改成这个形状);坏行、
 * 没有要改的失败的行回原文(一个字节不动)。
 */
function migrateFailureResults(line: string): string {
	if (!FAILURE_HINT.test(line)) return line;
	const row = parseJsonLine(line);
	if (!isPlainObject(row) || !Array.isArray(row.messages)) return line;
	if (!isPatchLine(line) && !("identity" in row)) return line;
	let changed = false;
	const messages = row.messages.map((message: unknown) => {
		if (!isPlainObject(message)) return message;
		const result = migrateFailureResult(message.result);
		if (result === message.result) return message;
		changed = true;
		return Object.fromEntries(
			Object.entries(message).map(([key, value]) =>
				key === "result" ? [key, result] : [key, value],
			),
		);
	});
	if (!changed) return line;
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(row).map(([key, value]) =>
				key === "messages" ? [key, messages] : [key, value],
			),
		),
	);
}

/**
 * 一行历史(jsonl 的一行原文)迁成最新形状:先改行的形状({@link migrateLineShape}),再把消息里老形状的失败结果
 * 改成结果形状({@link migrateFailureResults})。后一步不看这一行是不是老行:开发期写下的、已经带 `identity` 的行
 * 与 `rowId` 打头的补丁行里也有老失败。什么都不用改的行回原文(一个字节不动),所以迁两遍和迁一遍一样。
 */
export function migrateHistoryLine(line: string): string {
	return migrateFailureResults(migrateLineShape(line));
}

/**
 * 行的形状:老 `source` → 0.x 的推送种类 → `feature`,再把格改成现在的名字;老补丁行的 `patch` → `rowId`。
 * 已经是现在形状的行(带 `identity`、`rowId` 打头的补丁行)、推不出「替谁发的」的坏行
 * (既没有 `uid`、也没有 `extensionId` + `externalId` 一对)、推送种类认不得的坏行、读不懂的行回原文(一个字节不动)。
 */
function migrateLineShape(line: string): string {
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
 * 0.x 的每种载荷在 1.0 叫什么(3a-16;小程序卡改成原生分享是 3b-31)。
 * 0.x 多一种、这里没给去向,编译不过;守卫见 `__tests__/repush-snapshot-payloads.test.ts`。
 */
const PAYLOAD_KIND_RENAMES = {
	text: "text",
	image: "image",
	composite: "composite",
	"forward-images": "image-group",
	"miniapp-card": "native-share",
} as const satisfies Record<ZeroPayloadKind, NotificationPayload["kind"]>;

/**
 * B 站在 QQ 小程序里的 appid。小程序卡那时只有 B 站的链接解析产出,所以旧原件里的卡都补这一个。
 * 迁移只认冻住的值,不 import `bilibili/`;与解析器的 `QQ_MINI_APP_ID` 同值,由
 * `__tests__/repush-snapshot-payloads.test.ts` 钉住。
 */
const FROZEN_MINI_APP_ID = "1109937557";

/** 小程序卡的四格在原生分享里叫什么(`title` 同名,照搬)。 */
const MINIAPP_CARD_FIELD_RENAMES: ReadonlyMap<string, string> = new Map([
	["desc", "description"],
	["picUrl", "imageUrl"],
	["path", "pagePath"],
	["jumpUrl", "webUrl"],
]);

/** 小程序卡 → 原生分享:四格原位改名、`kind` 换新、紧跟 `kind` 补 `appId`。 */
function miniAppCardToNativeShare(card: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(card).flatMap(([key, value]): [string, unknown][] =>
			key === "kind"
				? [
						["kind", PAYLOAD_KIND_RENAMES["miniapp-card"]],
						["appId", FROZEN_MINI_APP_ID],
					]
				: [[MINIAPP_CARD_FIELD_RENAMES.get(key) ?? key, value]],
		),
	);
}

/** 把对象里的一个键换个名字,**键留在原来的位置**、值不动。 */
function renameKey(
	value: Record<string, unknown>,
	from: string,
	to: string,
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).map(([key, v]) => [key === from ? to : key, v]));
}

/**
 * 3a-16:原件里一条载荷改成活的 `NotificationPayload` 的名字 —— 图集 `forward-images` → `image-group`、它的开关
 * `forward` → `mergeForward`(图的 `{ url, width?, height? }` 本来就是 `PostImage` 的子集,照搬);composite 每一段的
 * 判别键 `type` → `kind`。3b-31:小程序卡 `miniapp-card` → 原生分享 `native-share`(`desc` / `picUrl` / `path` /
 * `jumpUrl` 原位改名,补 `appId`)。键都留在原来的位置。已经是新名字的、读不懂的回同一个对象。
 */
function migrateRepushPayload(payload: unknown): unknown {
	if (!isPlainObject(payload)) return payload;
	let next = payload;
	if (payload.kind === "forward-images") {
		next = {
			...renameKey(payload, "forward", "mergeForward"),
			kind: PAYLOAD_KIND_RENAMES["forward-images"],
		};
	}
	if (payload.kind === "miniapp-card") next = miniAppCardToNativeShare(payload);
	if (Array.isArray(payload.segments)) {
		let changed = false;
		const segments = (payload.segments as unknown[]).map((seg) => {
			if (!isPlainObject(seg) || !("type" in seg) || "kind" in seg) return seg;
			changed = true;
			return renameKey(seg, "type", "kind");
		});
		if (changed) next = { ...next, segments };
	}
	return next;
}

/**
 * 一份重推原件(`history/repush/<日>/<行 id>.json`)改成现在的形状:`v` → `version`(⑱c,**键留在原来的位置**),每条消息的
 * 载荷改成活的名字(3a-16,{@link migrateRepushPayload})。什么都不用改的、读不懂的回 `undefined`(不改写),所以迁两遍和
 * 迁一遍一样。
 */
function migrateRepushSnapshot(value: unknown): Record<string, unknown> | undefined {
	if (!isPlainObject(value)) return undefined;
	let changed = false;
	let next = value;
	if ("v" in value && !("version" in value)) {
		next = renameKey(value, "v", "version");
		changed = true;
	}
	if (Array.isArray(value.messages)) {
		let payloadChanged = false;
		const messages = (value.messages as unknown[]).map((message) => {
			if (!isPlainObject(message)) return message;
			const payload = migrateRepushPayload(message.payload);
			if (payload === message.payload) return message;
			payloadChanged = true;
			return { ...message, payload };
		});
		if (payloadChanged) {
			next = { ...next, messages };
			changed = true;
		}
	}
	return changed ? next : undefined;
}

export interface RepushSnapshotMigration {
	/** 改写过的原件(绝对路径)。 */
	rewritten: string[];
	/** 有图读不到、整份作废的原件(绝对路径;文件已经从新代里删了)。 */
	voided: string[];
}

/**
 * 新代里每份重推原件迁成最新的形状:`v` → `version`(⑱c)、载荷改成活的名字(3a-16),图格 `{ ref, mime, own? }` →
 * 图库引用(⑳d,见 `history-images.ts`;它排在改名之后,读的是段的新判别键 `kind`),**一份只写一次**。有一张图读不到的原件整份作废:从新代里删掉(搬位置时是复制,删的是新代
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
			reason: serverText("service.migration.history.text.1", {
				count: swept.snapshotDays.length,
				value1: opts.retentionDays,
			}),
		});
	}
	return { clearedThrough: swept.clearedThrough, snapshotDays: swept.snapshotDays, skipped };
}
