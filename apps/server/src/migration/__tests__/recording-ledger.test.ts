/**
 * 迁移推「在记」小账(`migration/recording.ts`,ADR-0027 决策 3 / 13,㉖f)。
 *
 * 直接给一棵「统计迁完文件键与行之后」的新代目录:订阅文件、核心设置、`stats/{followers,posts,live,seen}` 与水位线
 * `stats/since`,看它写出的 `stats/recording/<订阅 id>.jsonl` 与删掉的 `seen/`、`since`。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { compressRecordingEntries } from "../../stats/recording-compress.js";
import type { RecordingEntry } from "../../stats/store.js";
import { migrateRecordingLedger } from "../recording.js";

const BILI = "b0000000-0000-4000-8000-000000000001";
const BILI2 = "b0000000-0000-4000-8000-000000000002";
const EXT = "e0000000-0000-4000-8000-000000000001";
const hour = (n: number) => new Date(Date.UTC(2026, 4, 10, n)).toISOString();
const at = (n: number, minute = 30) => new Date(Date.UTC(2026, 4, 10, n, minute)).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

let dir: string;
let skipped: string[];

async function put(path: string, text: string) {
	const full = join(dir, path);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, text);
}

function sub(id: string, sourceKey: string, features?: Record<string, boolean>) {
	return {
		id,
		identity: { sourceKey, externalId: id.slice(-1) },
		overrides: features ? { features } : {},
		specialUsers: [],
	};
}

async function putSubs(rows: unknown[], core: unknown = { defaults: {} }) {
	await put(
		join("config", "subscriptions.json"),
		JSON.stringify({ tags: [], subscriptions: rows }),
	);
	await put(join("config", "settings", "core.json"), JSON.stringify(core));
}

async function ledger(id: string) {
	try {
		return (await readFile(join(dir, "stats", "recording", `${id}.jsonl`), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind: string; startedAt: string; endedAt: string });
	} catch {
		return undefined;
	}
}

const run = () => migrateRecordingLedger(dir, (reason) => skipped.push(reason));
const exists = (path: string) =>
	stat(join(dir, path)).then(
		() => true,
		() => false,
	);

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-recording-ledger-"));
	skipped = [];
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("B 站订阅:那个小时任何一条 B 站订阅有粉丝样本 = BN 那时在跑", () => {
	it("posts 按覆盖小时记、live 按现在的直播开关、followers 按自己的样本小时;相邻小时合成一段区间", async () => {
		await putSubs([
			sub(BILI, "bilibili"),
			sub(BILI2, "bilibili", { liveStart: false, liveEnd: false }),
		]);
		// BILI 的样本在 1、2、3 点与 7 点;BILI2 的在 3、4 点 —— 覆盖是两位的并集:1-4 点、7 点。
		await put(
			join("stats", "followers", `${BILI}.jsonl`),
			jsonl([1, 2, 3, 7].map((h) => ({ ts: at(h), value: h }))),
		);
		await put(
			join("stats", "followers", `${BILI2}.jsonl`),
			jsonl([3, 4].map((h) => ({ ts: at(h), value: h }))),
		);
		const written = await run();
		expect(written.sort()).toEqual(
			[BILI, BILI2].map((id) => join(dir, "stats", "recording", `${id}.jsonl`)).sort(),
		);
		expect(await ledger(BILI)).toEqual([
			{ kind: "followers", startedAt: hour(1), endedAt: hour(4) },
			{ kind: "live", startedAt: hour(1), endedAt: hour(5) },
			{ kind: "posts", startedAt: hour(1), endedAt: hour(5) },
			{ kind: "followers", startedAt: hour(7), endedAt: hour(8) },
			{ kind: "live", startedAt: hour(7), endedAt: hour(8) },
			{ kind: "posts", startedAt: hour(7), endedAt: hour(8) },
		]);
		// BILI2 的直播类开关全关着:不记 live(直播用现在的开关近似);它自己的首个样本在 3 点,覆盖只从 3 点起收。
		expect(await ledger(BILI2)).toEqual([
			{ kind: "followers", startedAt: hour(3), endedAt: hour(5) },
			{ kind: "posts", startedAt: hour(3), endedAt: hour(5) },
			{ kind: "posts", startedAt: hour(7), endedAt: hour(8) },
		]);
	});

	it("水位线之前的小时不收;盘上什么都没有的 B 站订阅一格都不记", async () => {
		await putSubs([sub(BILI, "bilibili"), sub(BILI2, "bilibili")]);
		await put(
			join("stats", "followers", `${BILI}.jsonl`),
			jsonl([1, 2, 3].map((h) => ({ ts: at(h), value: h }))),
		);
		await put(join("stats", "since"), at(2));
		await run();
		expect(await ledger(BILI)).toEqual([
			{ kind: "followers", startedAt: hour(1), endedAt: hour(4) },
			{ kind: "live", startedAt: hour(2), endedAt: hour(4) },
			{ kind: "posts", startedAt: hour(2), endedAt: hour(4) },
		]);
		expect(await ledger(BILI2)).toBeUndefined();
	});

	it("有作品 / 开播的覆盖小时照记(在自己首个样本之前也算);不在覆盖里的作品不记", async () => {
		await putSubs([sub(BILI, "bilibili")]);
		await put(
			join("stats", "followers", `${BILI}.jsonl`),
			jsonl([3, 4, 5].map((h) => ({ ts: at(h), value: h }))),
		);
		await put(
			join("stats", "posts", `${BILI}.jsonl`),
			jsonl([{ id: "a", hasVideo: true, publishedAt: at(4) }]),
		);
		await run();
		const rows = (await ledger(BILI)) ?? [];
		expect(rows.filter((r) => r.kind === "posts")).toEqual([
			{ kind: "posts", startedAt: hour(3), endedAt: hour(6) },
		]);
	});
});

describe("拓展订阅:seen 行所在的小时 = 在记", () => {
	it("posts 记 seen 与作品所在的小时,live 按现在的开关,followers 按自己的样本", async () => {
		await putSubs([sub(EXT, "douyin")]);
		await put(
			join("stats", "seen", `${EXT}.jsonl`),
			jsonl([{ ts: at(2) }, { ts: at(3, 5) }, { ts: at(9) }]),
		);
		await put(
			join("stats", "posts", `${EXT}.jsonl`),
			jsonl([{ id: "p", hasVideo: false, publishedAt: at(5) }]),
		);
		await put(join("stats", "followers", `${EXT}.jsonl`), jsonl([{ ts: at(2), value: 1 }]));
		await run();
		expect(await ledger(EXT)).toEqual([
			{ kind: "followers", startedAt: hour(2), endedAt: hour(3) },
			{ kind: "live", startedAt: hour(2), endedAt: hour(4) },
			{ kind: "posts", startedAt: hour(2), endedAt: hour(4) },
			{ kind: "posts", startedAt: hour(5), endedAt: hour(6) },
			{ kind: "live", startedAt: hour(9), endedAt: hour(10) },
			{ kind: "posts", startedAt: hour(9), endedAt: hour(10) },
		]);
	});

	it("直播类开关都关着:不记 live", async () => {
		await putSubs([sub(EXT, "douyin", { liveStart: false, liveEnd: false })]);
		await put(join("stats", "seen", `${EXT}.jsonl`), jsonl([{ ts: at(2) }]));
		await run();
		expect((await ledger(EXT))?.map((r) => r.kind)).toEqual(["posts"]);
	});

	it("全局默认里关着直播类开关、订阅覆盖又打开:按有效值", async () => {
		await putSubs([sub(EXT, "douyin", { liveStart: true })], {
			defaults: { features: { liveStart: false, liveEnd: false } },
		});
		await put(join("stats", "seen", `${EXT}.jsonl`), jsonl([{ ts: at(2) }]));
		await run();
		expect((await ledger(EXT))?.map((r) => r.kind)).toEqual(["live", "posts"]);
	});
});

describe("收尾与读不懂", () => {
	it("seen 目录与 since 文件读完就删", async () => {
		await putSubs([sub(EXT, "douyin")]);
		await put(join("stats", "seen", `${EXT}.jsonl`), jsonl([{ ts: at(2) }]));
		await put(join("stats", "since"), at(1));
		await run();
		expect(await exists(join("stats", "seen"))).toBe(false);
		expect(await exists(join("stats", "since"))).toBe(false);
	});

	it("订阅文件读不懂:整步跳过、留一句,旧文件原样不动", async () => {
		await put(join("config", "subscriptions.json"), "{不是 json");
		await put(join("stats", "seen", `${EXT}.jsonl`), jsonl([{ ts: at(2) }]));
		expect(await run()).toEqual([]);
		expect(skipped).toHaveLength(1);
		expect(await exists(join("stats", "seen", `${EXT}.jsonl`))).toBe(true);
		expect(await exists(join("stats", "recording"))).toBe(false);
	});

	it("核心设置读不懂同样整步跳过;核心设置不在(全新)就用出厂开关", async () => {
		await put(
			join("config", "subscriptions.json"),
			JSON.stringify({ tags: [], subscriptions: [sub(EXT, "douyin")] }),
		);
		await put(join("config", "settings", "core.json"), "坏的");
		expect(await run()).toEqual([]);
		expect(skipped).toHaveLength(1);
		await rm(join(dir, "config", "settings", "core.json"));
		await put(join("stats", "seen", `${EXT}.jsonl`), jsonl([{ ts: at(2) }]));
		await run();
		// 出厂开关:作品开、开播开 → posts 与 live 都记。
		expect((await ledger(EXT))?.map((r) => r.kind)).toEqual(["live", "posts"]);
	});
});

describe("迁移写出的账和压缩规则对得上(㉘d)", () => {
	/**
	 * 迁移写的区间本来就是合好的,行序也照压缩的次序(`startedAt`、`kind`、`endedAt`,同一个比较函数)写:
	 * 迁移的产出就是规范形态,再过一遍压缩(不管切线落在哪)**逐行不变**,开机第一趟压缩不必把每份账重排一遍。
	 */
	it("再过一遍 compressRecordingEntries,逐行不变(切线在全部区间之前 / 之后各一遍)", async () => {
		await putSubs([
			sub(BILI, "bilibili"),
			sub(BILI2, "bilibili", { liveStart: false, liveEnd: false }),
			sub(EXT, "douyin"),
		]);
		await put(
			join("stats", "followers", `${BILI}.jsonl`),
			jsonl([1, 2, 3, 7].map((h) => ({ ts: at(h), value: h }))),
		);
		await put(
			join("stats", "followers", `${BILI2}.jsonl`),
			jsonl([3, 4].map((h) => ({ ts: at(h), value: h }))),
		);
		await put(
			join("stats", "posts", `${BILI}.jsonl`),
			jsonl([{ id: "a", hasVideo: true, publishedAt: at(2) }]),
		);
		await put(
			join("stats", "seen", `${EXT}.jsonl`),
			jsonl([2, 3, 4, 9].map((h) => ({ ts: at(h) }))),
		);
		const written = await run();
		expect(written).toHaveLength(3);
		for (const id of [BILI, BILI2, EXT]) {
			const rows = ((await ledger(id)) ?? []) as RecordingEntry[];
			expect(rows.length, id).toBeGreaterThan(1);
			for (const now of [
				new Date("2026-06-30T12:00:00.000Z"),
				new Date("2026-05-10T12:00:00.000Z"),
			]) {
				expect(compressRecordingEntries(rows, now), `${id} @ ${now.toISOString()}`).toEqual(rows);
			}
		}
	});
});
