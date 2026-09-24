/**
 * 开机迁移:B 站的 `<uid>.jsonl` 并进 `<订阅 id>.jsonl`(ADR-0020 决策 2 的 🔗)。
 *
 * 守的几件事:
 *   - 第一次开机:三个目录(作品 / 直播 / 粉丝)各自改名,内容一字不动;
 *   - 回退过又升级回来(两份都在):id 那份在前、uid 那份接在后面,uid 那份删掉;
 *   - 每次开机都跑、跑第二次什么都不动;
 *   - 半路崩了:再跑一次补完,不多出重复的行;就算多出了,读的人也不多算;
 *   - 找不到订阅的 uid 文件不碰;停用的订阅照迁;同一个 uid 两条订阅,两条都拿到数据。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFansStore } from "../../fans/store.js";
import { dailyFansSeries, summarizeLiveSessions } from "../aggregate.js";
import { migrateStatsFileKeys } from "../migrate-file-keys.js";
import { createStatsStore } from "../store.js";

const ID_A = "a0000000-0000-4000-8000-00000000000a";
const ID_B = "b0000000-0000-4000-8000-00000000000b";
const ID_EXT = "e0000000-0000-4000-8000-00000000000e";
const DIRS = [join("stats", "dyn"), join("stats", "live"), "fans"] as const;

const bili = (id: string, uid: string, enabled = true) => ({
	kind: "bilibili" as const,
	id,
	uid,
	enabled,
});
const ext = (id: string) => ({ kind: "extension" as const, id });

const jsonl = (rows: readonly unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const T = (d: number, h = 0) =>
	`2026-05-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;

let dataDir: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-stats-migrate-"));
	for (const d of DIRS) await mkdir(join(dataDir, d), { recursive: true });
	vi.clearAllMocks();
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

const file = (dir: string, key: string) => join(dataDir, dir, `${key}.jsonl`);
const put = (dir: string, key: string, content: string) => writeFile(file(dir, key), content);
const read = (dir: string, key: string) => readFile(file(dir, key), "utf-8");
const ls = async (dir: string) => (await readdir(join(dataDir, dir))).sort();

const run = (subscriptions: readonly unknown[]) =>
	migrateStatsFileKeys({ dataDir, subscriptions: subscriptions as never, logger });

const DYN = jsonl([{ id: "p1", type: "DYNAMIC_TYPE_AV", ts: T(10) }]);
const LIVE = jsonl([
	{ k: "start", ts: T(10, 1) },
	{ k: "end", ts: T(10, 3), peak: "1.2万" },
]);
const FANS = jsonl([
	{ ts: T(10), value: 100 },
	{ ts: T(11), value: 110 },
]);

describe("第一次开机:改名", () => {
	it("三个目录各自 <uid>.jsonl → <订阅 id>.jsonl,内容一字不动", async () => {
		await put(DIRS[0], "101", DYN);
		await put(DIRS[1], "101", LIVE);
		await put(DIRS[2], "101", FANS);
		const got = await run([bili(ID_A, "101")]);
		expect(got).toEqual({ renamed: 3, merged: 0, copied: 0 });
		for (const [dir, content] of [
			[DIRS[0], DYN],
			[DIRS[1], LIVE],
			[DIRS[2], FANS],
		] as const) {
			expect(await ls(dir)).toEqual([`${ID_A}.jsonl`]);
			expect(await read(dir, ID_A)).toBe(content);
		}
	});

	it("只动有的:某个目录没有 uid 文件就跳过", async () => {
		await put(DIRS[2], "101", FANS);
		expect(await run([bili(ID_A, "101")])).toEqual({ renamed: 1, merged: 0, copied: 0 });
		expect(await ls(DIRS[0])).toEqual([]);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
	});

	it("停用的订阅照迁 —— 统计页照样列着他", async () => {
		await put(DIRS[2], "101", FANS);
		await run([bili(ID_A, "101", false)]);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
	});

	it("迁了东西打一行汇总;什么都没迁就不出声", async () => {
		await put(DIRS[0], "101", DYN);
		await run([bili(ID_A, "101")]);
		expect(logger.info).toHaveBeenCalledTimes(1);
		logger.info.mockClear();
		await run([bili(ID_A, "101")]);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("数据目录还没有这几个子目录(全新安装)→ 不报错", async () => {
		await rm(dataDir, { recursive: true, force: true });
		await mkdir(dataDir, { recursive: true });
		await expect(run([bili(ID_A, "101")])).resolves.toEqual({ renamed: 0, merged: 0, copied: 0 });
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("回退过又升级回来:两份都在 → 并", () => {
	it("id 那份在前、uid 那份接在后面,uid 那份删掉", async () => {
		const before = jsonl([{ ts: T(10), value: 100 }]);
		const during = jsonl([
			{ ts: T(12), value: 120 },
			{ ts: T(13), value: 130 },
		]);
		await put(DIRS[2], ID_A, before);
		await put(DIRS[2], "101", during);
		expect(await run([bili(ID_A, "101")])).toEqual({ renamed: 0, merged: 1, copied: 0 });
		expect(await read(DIRS[2], ID_A)).toBe(before + during);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
	});

	it("id 那份末尾没换行 → 补一个再接,不把两行粘成一行", async () => {
		await put(DIRS[0], ID_A, JSON.stringify({ id: "n1", kind: "post", ts: T(10) }));
		await put(DIRS[0], "101", DYN);
		await run([bili(ID_A, "101")]);
		expect(await read(DIRS[0], ID_A)).toBe(
			`${JSON.stringify({ id: "n1", kind: "post", ts: T(10) })}\n${DYN}`,
		);
	});
});

describe("每次开机都跑", () => {
	it("跑第二次什么都不动", async () => {
		await put(DIRS[0], "101", DYN);
		await put(DIRS[2], ID_A, FANS);
		await put(DIRS[2], "101", jsonl([{ ts: T(12), value: 120 }]));
		await run([bili(ID_A, "101")]);
		const dyn = await read(DIRS[0], ID_A);
		const fans = await read(DIRS[2], ID_A);
		expect(await run([bili(ID_A, "101")])).toEqual({ renamed: 0, merged: 0, copied: 0 });
		expect(await read(DIRS[0], ID_A)).toBe(dyn);
		expect(await read(DIRS[2], ID_A)).toBe(fans);
	});
});

describe("半路崩了", () => {
	it("并好的内容已经换上、uid 那份还没删 → 再跑一次只删 uid 那份,不再接一遍", async () => {
		const during = jsonl([{ ts: T(12), value: 120 }]);
		await put(DIRS[2], ID_A, FANS + during); // 换上了
		await put(DIRS[2], "101", during); // 还没删
		expect(await run([bili(ID_A, "101")])).toEqual({ renamed: 0, merged: 1, copied: 0 });
		expect(await read(DIRS[2], ID_A)).toBe(FANS + during);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
	});

	it("临时文件写了一半没换上 → 两份原样都在,再跑一次正常并完、临时文件不留", async () => {
		const during = jsonl([{ ts: T(12), value: 120 }]);
		await put(DIRS[2], ID_A, FANS);
		await put(DIRS[2], "101", during);
		await writeFile(join(dataDir, DIRS[2], `${ID_A}.jsonl.migrating`), '{"ts":"2026-05-1');
		await run([bili(ID_A, "101")]);
		expect(await read(DIRS[2], ID_A)).toBe(FANS + during);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
	});

	it("走改名那条路时,上次留下的半截临时文件也清掉(读的人不认它,但别让它永远躺着)", async () => {
		// 同一个 uid 两条订阅、上次复制到一半崩了,这次其中一条已经删了 —— 剩下那条走改名。
		await put(DIRS[2], "101", FANS);
		await writeFile(join(dataDir, DIRS[2], `${ID_A}.jsonl.migrating`), '{"ts":"2026-05-1');
		await run([bili(ID_A, "101")]);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`]);
		expect(await read(DIRS[2], ID_A)).toBe(FANS);
	});

	it("就算多出了重复的行,读的人也不多算:作品按 id 去重、场次照常配对、粉丝增量不变", async () => {
		const dynRows = [
			{ id: "p1", kind: "video", ts: T(10) },
			{ id: "p2", kind: "post", ts: T(11) },
		];
		const liveRows = [
			{ k: "start", ts: T(10, 1) },
			{ k: "end", ts: T(10, 3), peak: 12_000 },
			// ↓ 这三帧是「回退期间写的那段」,下面整段再接一遍
			{ k: "start", ts: T(11, 1) },
			{ k: "end", ts: T(11, 2), peak: 9000 },
			{ k: "start", ts: T(11, 20) },
		];
		const tail = [
			{ ts: T(12), value: 120 },
			{ ts: T(13), value: 90 },
		];
		const fansRows = [{ ts: T(10), value: 100 }, { ts: T(11), value: 110 }, ...tail];
		// 干净的一份
		await put(DIRS[0], "clean", jsonl(dynRows));
		await put(DIRS[1], "clean", jsonl(liveRows));
		await put(DIRS[2], "clean", jsonl(fansRows));
		// 「接了两遍」的一份:回退期间写的那段在末尾重复
		await put(DIRS[0], "dup", jsonl([...dynRows, ...dynRows.slice(1)]));
		await put(DIRS[1], "dup", jsonl([...liveRows, ...liveRows.slice(2)]));
		await put(DIRS[2], "dup", jsonl([...fansRows, ...tail]));

		const stats = createStatsStore({ dataDir, logger });
		const fans = createFansStore({ dataDir, logger });
		const since = T(1);
		expect(await stats.listDynamics("dup", since)).toEqual(
			await stats.listDynamics("clean", since),
		);
		expect(await stats.listLiveSessions("dup", since)).toEqual(
			await stats.listLiveSessions("clean", since),
		);
		const now = new Date(T(12));
		expect(
			summarizeLiveSessions(await stats.listLiveSessions("dup", since), { now, isLive: true }),
		).toEqual(
			summarizeLiveSessions(await stats.listLiveSessions("clean", since), { now, isLive: true }),
		);
		for (const target of [T(9), T(10), T(11, 12), T(12), T(13), T(20)]) {
			expect(await fans.findNearestBefore("dup", target), target).toEqual(
				await fans.findNearestBefore("clean", target),
			);
		}
		expect(await fans.findEarliest("dup")).toEqual(await fans.findEarliest("clean"));
		const series = async (key: string) =>
			dailyFansSeries(await fans.listSamplesSince(key, since), {
				days: 5,
				tzOffsetMin: 0,
				now: new Date(T(13, 12)),
			});
		expect(await series("dup")).toEqual(await series("clean"));
	});
});

describe("不该碰的不碰", () => {
	it("找不到 B 站订阅的 uid 文件原样留着", async () => {
		await put(DIRS[2], "999", FANS);
		await put(DIRS[2], "101", FANS);
		await run([bili(ID_A, "101"), ext(ID_EXT)]);
		expect(await ls(DIRS[2])).toEqual(["999.jsonl", `${ID_A}.jsonl`].sort());
		expect(await read(DIRS[2], "999")).toBe(FANS);
	});

	it("拓展订阅本来就按订阅 id 命名,没有什么可迁", async () => {
		await put(DIRS[0], ID_EXT, DYN);
		expect(await run([ext(ID_EXT)])).toEqual({ renamed: 0, merged: 0, copied: 0 });
		expect(await read(DIRS[0], ID_EXT)).toBe(DYN);
	});
});

describe("同一个 uid 两条 B 站订阅(服务端不判重,只有面板挡着)", () => {
	it("两条都拿到这份数据 —— 与改之前两行共读一个 uid 文件同一个结果", async () => {
		await put(DIRS[2], "101", FANS);
		const got = await run([bili(ID_A, "101"), bili(ID_B, "101", false)]);
		expect(got.renamed + got.copied).toBe(2);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`, `${ID_B}.jsonl`].sort());
		expect(await read(DIRS[2], ID_A)).toBe(FANS);
		expect(await read(DIRS[2], ID_B)).toBe(FANS);
	});

	it("复制到一半崩了 → 再跑一次补完,已经有的那份不重复", async () => {
		await put(DIRS[2], "101", FANS);
		await put(DIRS[2], ID_A, FANS); // 第一份已复制
		await run([bili(ID_A, "101"), bili(ID_B, "101")]);
		expect(await read(DIRS[2], ID_A)).toBe(FANS);
		expect(await read(DIRS[2], ID_B)).toBe(FANS);
		expect(await ls(DIRS[2])).toEqual([`${ID_A}.jsonl`, `${ID_B}.jsonl`].sort());
	});
});
