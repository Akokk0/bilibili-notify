/**
 * 迁移压老粉丝样本(`migration/followers.ts`,ADR-0027 决策 8、15;㉘c)。
 *
 * 直接给一棵「统计迁完文件键之后」的新代目录:`stats/followers/<订阅 id>.jsonl` 里还是 0.x 的 `{ ts, value }` 行
 * (B 站订阅与拓展订阅一样),看它按「现在」压成新形状写回。
 */

import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { FOLLOWERS_DIR } from "../../followers/store.js";
import { migrateFollowerCompression } from "../followers.js";

const BILI = "b0000000-0000-4000-8000-000000000001";
const EXT = "e0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-06-30T12:00:00.000Z"); // 切线 2026-06-22T12:00:00Z
const old = (ts: string, value: number) => JSON.stringify({ ts, value });

let dir: string;
let skipped: string[];
const run = (now = NOW) => migrateFollowerCompression(dir, now, (reason) => skipped.push(reason));
const fileOf = (key: string) => join(dir, ...FOLLOWERS_DIR, `${key}.jsonl`);
async function put(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-followers-compression-"));
	skipped = [];
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 旧点:00–02 点同值 100(00 点那小时两条)、03 点 105;切线之后两条原样。 */
const ZERO_ROWS = [
	old("2026-06-10T00:10:00.000Z", 100),
	old("2026-06-10T00:50:00.000Z", 100),
	old("2026-06-10T01:20:00.000Z", 100),
	old("2026-06-10T02:05:00.000Z", 100),
	old("2026-06-10T03:00:00.000Z", 105),
	old("2026-06-29T10:00:00.000Z", 200),
	old("2026-06-29T10:10:00.000Z", 201),
];
const COMPACTED =
	'{"sampledAt":"2026-06-10T00:50:00.000Z","followers":100,"lastSampledAt":"2026-06-10T02:05:00.000Z"}\n' +
	'{"sampledAt":"2026-06-10T03:00:00.000Z","followers":105}\n' +
	'{"sampledAt":"2026-06-29T10:00:00.000Z","followers":200}\n' +
	'{"sampledAt":"2026-06-29T10:10:00.000Z","followers":201}\n';

describe("migrateFollowerCompression", () => {
	it("0.x 的 { ts, value } 行压成新形状写回:旧的同值小时合成段,切线之后原样;回写过的文件", async () => {
		await put(fileOf(BILI), `${ZERO_ROWS.join("\n")}\n`);
		expect(await run()).toEqual([fileOf(BILI)]);
		expect(await readFile(fileOf(BILI), "utf8")).toBe(COMPACTED);
		expect(skipped).toEqual([]);
	});

	it("B 站订阅与拓展订阅一样处理;已经是新形状的行也认(新旧混着)", async () => {
		await put(fileOf(BILI), `${ZERO_ROWS.join("\n")}\n`);
		await put(
			fileOf(EXT),
			`${[
				old("2026-06-29T10:00:00.000Z", 7),
				JSON.stringify({ sampledAt: "2026-06-29T10:10:00.000Z", followers: 8 }),
			].join("\n")}\n`,
		);
		expect((await run()).sort()).toEqual([fileOf(BILI), fileOf(EXT)].sort());
		expect(await readFile(fileOf(EXT), "utf8")).toBe(
			'{"sampledAt":"2026-06-29T10:00:00.000Z","followers":7}\n{"sampledAt":"2026-06-29T10:10:00.000Z","followers":8}\n',
		);
	});

	it("坏行(不是 JSON / 缺格 / 时刻解析不了)丢掉并合起来记一条,带个数;空行不算", async () => {
		await put(fileOf(BILI), `not json\n${old("2026-06-29T10:00:00.000Z", 200)}\n\n{"value":1}\n`);
		await put(fileOf(EXT), `${JSON.stringify({ ts: "坏时刻", value: 3 })}\n`);
		await run();
		expect(await readFile(fileOf(BILI), "utf8")).toBe(
			'{"sampledAt":"2026-06-29T10:00:00.000Z","followers":200}\n',
		);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]).toContain("3 条");
	});

	it("用迁移注入的「现在」切线:往后推 10 天,切线之后的两条也压了(同值合不了、各是一个小时点)", async () => {
		await put(fileOf(BILI), `${ZERO_ROWS.join("\n")}\n`);
		await run(new Date("2026-07-10T12:00:00.000Z"));
		// 06-29 10:00 与 10:10 在同一小时,留最晚的 10:10(201)。
		expect(await readFile(fileOf(BILI), "utf8")).toBe(
			COMPACTED.replace('{"sampledAt":"2026-06-29T10:00:00.000Z","followers":200}\n', ""),
		);
	});

	it("没有粉丝目录:什么都不做,回空", async () => {
		expect(await run()).toEqual([]);
		await expect(stat(join(dir, "stats"))).rejects.toThrow();
	});

	it("第 0 代不动:新代的文件是指向第 0 代的硬链接时,压缩换新文件、旧文件字节不变", async () => {
		const zeroFile = join(dir, "zero", "fans.jsonl");
		await put(zeroFile, `${ZERO_ROWS.join("\n")}\n`);
		await mkdir(dirname(fileOf(BILI)), { recursive: true });
		await link(zeroFile, fileOf(BILI));
		await run();
		expect(await readFile(zeroFile, "utf8")).toBe(`${ZERO_ROWS.join("\n")}\n`);
		expect(await readFile(fileOf(BILI), "utf8")).toBe(COMPACTED);
	});

	it("重跑结果相同", async () => {
		await put(fileOf(BILI), `${ZERO_ROWS.join("\n")}\n`);
		await run();
		const first = await readFile(fileOf(BILI), "utf8");
		await run();
		expect(await readFile(fileOf(BILI), "utf8")).toBe(first);
	});
});
