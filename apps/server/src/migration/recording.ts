import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { t as serverText } from "../i18n/index.js";
/**
 * 统计的「在记」小账:从 0.x 留下的数据**推出**老日子哪些小时在记,按小时区间写进新代的
 * `stats/recording/<订阅 id>.jsonl`(ADR-0027 决策 3 / 13;㉖f)。迁移之后,老日子在 `/overview` 上哪些格有数、
 * 哪些格是「没记录」,与迁移前的算法一致 —— 例外只有一条:直播用**现在**的直播开关近似(0.x 不看开关、有场次就是有)。
 *
 * 老规矩(旧的 `/overview` 路由)与它在账上的写法:
 *
 * - **B 站「那天有记录」**:任何一条 B 站订阅那天有粉丝样本 = BN 那天在跑 → 「那个小时任何一条 B 站订阅有粉丝样本」
 *   的小时,每条 B 站订阅的 `posts` 在记(0.x 不看开关都记);`live` 只给现在直播类开关开着的订阅记。
 * - **采集水位线**(`stats/since`):早于水位线那天的日子一律无记录 → 只收水位线所在小时及以后的小时。账以小时计、
 *   旧规矩按「水位线那天」整天切(与时区有关),所以水位线那天更早的几个小时不收:这是搬不成的一处小误差。
 * - **首采日**:一位订阅自己第一个粉丝样本之前、且那天什么都没发生的日子无记录;有活动的照常上色 → 收自己首个样本小时
 *   及以后的覆盖小时,再加上有作品 / 开播的那几个(覆盖着的)小时。
 * - **「一无所知」整行留白**:盘上没有粉丝样本、作品、场次中任何一样的 B 站订阅一格都不记。
 * - **拓展「那天有记录」**:看它自己的「在记」(`stats/seen`)→ `seen` 行所在的小时,`posts` 在记、`live` 按现在的开关;
 *   有活动的那天照数 → 再加有作品 / 开播的小时。不看水位线。
 * - **粉丝**:这条订阅自己的粉丝样本所在的小时(两支一样)。
 *
 * 读粉丝样本只为取时刻(满量约 231 万行),不整行解析;相邻的小时合成一段区间再写。读不懂订阅文件 / 核心设置就整步跳过。
 *
 * 「直播类开关开着」用的是**冻住的 0.x 旧读法**(五把直播开关任一开着,或特别关注名单上有人),不取活的
 * `needsLiveMonitor`:活的判定以后要多看特别开关,而老日子的账照 0.x 的规矩推,不随活判定漂。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_FEATURE_FLAGS } from "@bilibili-notify/internal";
import { CONFIG_DIR, CORE_SETTINGS_FILE } from "../config/store.js";
import { HOUR_MS } from "../followers/cutoff.js";
import { FOLLOWERS_DIR } from "../followers/store.js";
import { dataPath } from "../runtime/roots.js";
import { compareRecordingEntries } from "../stats/recording-compress.js";
import {
	type RecordingEntry,
	type RecordingKind,
	STATS_LIVE_DIR,
	STATS_POSTS_DIR,
	STATS_RECORDING_DIR,
} from "../stats/store.js";
import { isPlainObject, readJsonFile, rewriteTextFile } from "./files.js";
import { hourSetOf, readFollowerSampleTimes } from "./follower-times.js";

/** 老的「在记」证据目录与水位线文件:读完就删,新代不再有它们。 */
const ZERO_SEEN_DIR = ["stats", "seen"] as const;
const ZERO_SINCE_FILE = ["stats", "since"] as const;

/** 一行里 `"<key>":"<ISO>"` 的前 13 个字符(到小时)→ 整点小时序号。不整行解析:满量几百万行。 */
function hourReader(key: string) {
	const needle = `"${key}":"`;
	const memo = new Map<string, number>();
	return (line: string): number | undefined => {
		let head: string;
		const at = line.indexOf(needle);
		if (at >= 0) head = line.slice(at + needle.length, at + needle.length + 13);
		else {
			// 不是预期的写法(键序不同 / 格式不同):整行解析兜底。
			try {
				const value = (JSON.parse(line) as Record<string, unknown>)[key];
				if (typeof value !== "string") return undefined;
				head = value.slice(0, 13);
			} catch {
				return undefined;
			}
		}
		const known = memo.get(head);
		if (known !== undefined) return known;
		const ms = Date.parse(`${head}:00:00.000Z`);
		if (!Number.isFinite(ms)) return undefined;
		const hour = Math.floor(ms / HOUR_MS);
		memo.set(head, hour);
		return hour;
	};
}

async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw err;
	}
}

/** 一份 jsonl 里 `key` 那一格所在的小时集合。 */
async function hoursOf(path: string, key: string): Promise<Set<number>> {
	const readHour = hourReader(key);
	const hours = new Set<number>();
	for (const line of (await readText(path)).split("\n")) {
		if (!line) continue;
		const hour = readHour(line);
		if (hour !== undefined) hours.add(hour);
	}
	return hours;
}

/** 直播帧:开播到下播覆盖的每个小时;只有开播没有下播的只算开播那个小时。同时给出每场开播所在的小时。 */
async function liveHoursOf(path: string): Promise<{ spans: Set<number>; starts: Set<number> }> {
	const spans = new Set<number>();
	const starts = new Set<number>();
	let openHour: number | undefined;
	for (const line of (await readText(path)).split("\n")) {
		if (!line) continue;
		let frame: { kind?: unknown; occurredAt?: unknown };
		try {
			frame = JSON.parse(line) as typeof frame;
		} catch {
			continue;
		}
		if (typeof frame.occurredAt !== "string") continue;
		const ms = Date.parse(frame.occurredAt);
		if (!Number.isFinite(ms)) continue;
		const hour = Math.floor(ms / HOUR_MS);
		if (frame.kind === "start") {
			openHour = hour;
			starts.add(hour);
			spans.add(hour);
		} else if (frame.kind === "end" && openHour !== undefined) {
			for (let h = openHour; h <= hour; h++) spans.add(h);
			openHour = undefined;
		}
	}
	return { spans, starts };
}

/** 小时序号集合 → 相邻的合成的 `[起, 止)` 区间行。 */
function rangesOf(kind: RecordingKind, hours: ReadonlySet<number>): RecordingEntry[] {
	const sorted = [...hours].sort((a, b) => a - b);
	const out: RecordingEntry[] = [];
	let from: number | undefined;
	let prev = 0;
	const flush = () => {
		if (from === undefined) return;
		out.push({
			kind,
			startedAt: new Date(from * HOUR_MS).toISOString(),
			endedAt: new Date((prev + 1) * HOUR_MS).toISOString(),
		});
	};
	for (const h of sorted) {
		if (from !== undefined && h === prev + 1) {
			prev = h;
			continue;
		}
		flush();
		from = h;
		prev = h;
	}
	flush();
	return out;
}

const FEATURE_KEYS = [
	"post",
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
] as const;

/**
 * 冻住的 0.x 旧读法里「直播类开关」的五把:任一开着就算要监听直播。**不取** internal 的 `needsLiveMonitor`:
 * 活的判定会随产品改(3b-16 起要「特别开关开着且名单上有人带它」才算),而这里推的是**老日子**的账,
 * 老日子照 0.x 的规矩 —— 名单上有人就监听,不看特别开关(`git show v0.12.0:apps/server/src/runtime/engines.ts`
 * 第 1459–1460 行:按 `kinds` 把名单拆成两张,有人就开那一块)。
 */
const ZERO_LIVE_FEATURE_KEYS = [
	"liveStart",
	"liveStreaming",
	"liveEnd",
	"membership",
	"superchat",
] as const;

type Features = Record<(typeof FEATURE_KEYS)[number], boolean>;

/** 把一份(可能只写了一部分的)特性开关摊在底下那份上,只认布尔。 */
function layerFeatures(base: Features, raw: unknown): Features {
	if (!isPlainObject(raw)) return base;
	const out = { ...base };
	for (const key of FEATURE_KEYS) if (typeof raw[key] === "boolean") out[key] = raw[key];
	return out;
}

/**
 * 迁移一步:写 `stats/recording/`,删 `stats/seen/` 与 `stats/since`。回写过的文件(绝对路径)。
 * 订阅文件或核心设置读不懂就整步跳过(旧文件原样留着,新代不认它们),并在 `skip` 里留一句。
 */
export async function migrateRecordingLedger(
	dataRoot: string,
	skip: (reason: string) => void,
): Promise<string[]> {
	const subsFile = await readJsonFile(
		join(dataPath(dataRoot, ...CONFIG_DIR), "subscriptions.json"),
	);
	const coreFile = await readJsonFile(dataPath(dataRoot, ...CORE_SETTINGS_FILE));
	if (subsFile.kind === "unreadable" || coreFile.kind === "unreadable") {
		skip(serverText("service.migration.recording.text.1"));
		return [];
	}
	const rows =
		subsFile.kind === "ok" &&
		isPlainObject(subsFile.value) &&
		Array.isArray(subsFile.value.subscriptions)
			? subsFile.value.subscriptions
			: subsFile.kind === "missing"
				? []
				: undefined;
	if (rows === undefined) {
		skip(serverText("service.migration.recording.text.2"));
		return [];
	}
	const defaults: Features = layerFeatures(
		{ ...DEFAULT_FEATURE_FLAGS } as Features,
		coreFile.kind === "ok" &&
			isPlainObject(coreFile.value) &&
			isPlainObject(coreFile.value.defaults)
			? coreFile.value.defaults.features
			: undefined,
	);

	const sinceText = (await readText(dataPath(dataRoot, ...ZERO_SINCE_FILE))).trim();
	const sinceMs = Date.parse(sinceText);
	const sinceHour = Number.isFinite(sinceMs)
		? Math.floor(sinceMs / HOUR_MS)
		: Number.NEGATIVE_INFINITY;

	const postsDir = dataPath(dataRoot, ...STATS_POSTS_DIR);
	const liveDir = dataPath(dataRoot, ...STATS_LIVE_DIR);
	const followersDir = dataPath(dataRoot, ...FOLLOWERS_DIR);
	const seenDir = dataPath(dataRoot, ...ZERO_SEEN_DIR);
	const recordingDir = dataPath(dataRoot, ...STATS_RECORDING_DIR);

	interface Facts {
		id: string;
		builtIn: boolean;
		live: boolean;
		samples: Set<number>;
		posts: Set<number>;
		liveSpans: Set<number>;
		liveStarts: Set<number>;
		seen: Set<number>;
	}
	const facts: Facts[] = [];
	/** 任何一条 B 站订阅有粉丝样本的小时 = BN 那时在跑(老规矩)。 */
	const covered = new Set<number>();
	for (const row of rows) {
		if (!isPlainObject(row) || typeof row.id !== "string" || !isPlainObject(row.identity)) continue;
		const features = layerFeatures(
			defaults,
			isPlainObject(row.overrides) ? row.overrides.features : undefined,
		);
		// 新代里订阅文件已经迁好:名单在 `specialViewers`(0.x 的 `kinds` 至少一个,所以「非空」就是「有人带某一种」)。
		const hasSpecialViewers = Array.isArray(row.specialViewers) && row.specialViewers.length > 0;
		const file = `${row.id}.jsonl`;
		const builtIn = row.identity.sourceKey === BILIBILI_SOURCE_KEY;
		const live = await liveHoursOf(join(liveDir, file));
		const one: Facts = {
			id: row.id,
			builtIn,
			live: ZERO_LIVE_FEATURE_KEYS.some((key) => features[key]) || hasSpecialViewers,
			samples: hourSetOf(await readFollowerSampleTimes(join(followersDir, file))),
			posts: await hoursOf(join(postsDir, file), "publishedAt"),
			liveSpans: live.spans,
			liveStarts: live.starts,
			seen: builtIn ? new Set() : await hoursOf(join(seenDir, file), "ts"),
		};
		if (builtIn) for (const h of one.samples) covered.add(h);
		facts.push(one);
	}

	const written: string[] = [];
	for (const one of facts) {
		const posts = new Set<number>();
		const live = new Set<number>();
		if (one.builtIn) {
			const evidence = one.samples.size > 0 || one.posts.size > 0 || one.liveStarts.size > 0;
			if (evidence) {
				const firstSample =
					one.samples.size > 0 ? Math.min(...one.samples) : Number.NEGATIVE_INFINITY;
				for (const h of covered) {
					if (h < sinceHour || h < firstSample) continue;
					posts.add(h);
					if (one.live) live.add(h);
				}
				for (const h of one.posts) if (h >= sinceHour && covered.has(h)) posts.add(h);
				if (one.live)
					for (const h of one.liveStarts) if (h >= sinceHour && covered.has(h)) live.add(h);
			}
		} else {
			for (const h of one.seen) {
				posts.add(h);
				if (one.live) live.add(h);
			}
			for (const h of one.posts) posts.add(h);
			if (one.live) for (const h of one.liveStarts) live.add(h);
		}
		// 照账的规范次序写(与压缩同一个比较函数):迁移的产出就是规范形态,开机第一趟压缩不必重排。
		const lines = [
			...rangesOf("posts", posts),
			...rangesOf("live", live),
			...rangesOf("followers", one.samples),
		]
			.sort(compareRecordingEntries)
			.map((entry) => JSON.stringify(entry));
		if (lines.length === 0) continue;
		await mkdir(recordingDir, { recursive: true });
		const target = join(recordingDir, `${one.id}.jsonl`);
		await rewriteTextFile(target, `${lines.join("\n")}\n`);
		written.push(target);
	}
	await rm(seenDir, { recursive: true, force: true });
	await rm(dataPath(dataRoot, ...ZERO_SINCE_FILE), { force: true });
	return written;
}
