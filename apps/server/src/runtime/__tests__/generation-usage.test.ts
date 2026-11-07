/**
 * 旧版本数据(代)的列表、大小、删除(㉙c,ADR-0022 决策 7 与 2026-10-06 的 🔗)。
 *
 * 规则表的期望值全是手写的:「30 天」从**当前代**的 `generation.json.createdAt` 算,注入时钟、不真等;
 * 删除是不可恢复的,所以每条「不许删」都要证明盘上原封不动。
 */

import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationView } from "@bilibili-notify/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	listGenerationUsage,
	measureTree,
	removeGeneration,
	sweepGenerationLeftovers,
} from "../generation-usage.js";
import { GENERATION_FILE } from "../generations.js";

const DAY = 24 * 60 * 60 * 1000;
const CREATED = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let host: string;
beforeEach(async () => {
	host = await mkdtemp(join(tmpdir(), "bn-generation-usage-"));
});
afterEach(async () => {
	await rm(host, { recursive: true, force: true });
});

interface GenSpec {
	formatVersion?: number;
	createdAt?: string;
	lastActiveAt?: string;
	createdBy?: string;
	source?: { kind: "zero" | "empty" };
	/** 原样写进 generation.json(造读不懂的);给了就不用上面那些。 */
	raw?: string;
	/** 不写 generation.json。 */
	noFile?: boolean;
}

async function makeGen(name: string, spec: GenSpec = {}): Promise<string> {
	const dir = join(host, "generations", name);
	await mkdir(dir, { recursive: true });
	if (spec.noFile) return dir;
	const body =
		spec.raw ??
		JSON.stringify({
			formatVersion: spec.formatVersion ?? 1,
			migrationRevision: 1,
			createdAt: spec.createdAt ?? iso(CREATED),
			createdBy: spec.createdBy ?? "1.0.0",
			lastActiveAt: spec.lastActiveAt ?? iso(CREATED),
			source: spec.source ?? { kind: "empty" },
		});
	await writeFile(join(dir, GENERATION_FILE), body);
	return dir;
}

async function makeZero(): Promise<void> {
	await mkdir(join(host, "state"));
	await writeFile(join(host, "state", "globals.json"), "{}");
}

function opts(currentSeq: number, nowMs: number) {
	return { hostRoot: host, currentSeq, formatVersion: 1, now: () => nowMs };
}

function summary(list: GenerationView[]) {
	return list.map((g) => [g.seq, g.partial ? "partial" : "", g.lockReason, g.deletableAt]);
}

describe("列出所有代与能不能删(规则表)", () => {
	it("只有当前代:它自己,不许删,原因 current", async () => {
		await makeGen("1");
		const list = await listGenerationUsage(opts(1, CREATED + 99 * DAY));
		expect(summary(list)).toEqual([[1, "", "current", null]]);
		expect(list[0]?.current).toBe(true);
		expect(list[0]?.deletable).toBe(false);
	});

	it("0 → 1,当前 1 来自第 0 代:未满 30 天第 0 代锁(protected-source)并给到期时刻;满 30 天整可删", async () => {
		await makeZero();
		await makeGen("1", { source: { kind: "zero" } });
		const early = await listGenerationUsage(opts(1, CREATED + 29 * DAY));
		expect(summary(early)).toEqual([
			[0, "", "protected-source", iso(CREATED + 30 * DAY)],
			[1, "", "current", null],
		]);
		expect(early[0]?.deletable).toBe(false);
		const full = await listGenerationUsage(opts(1, CREATED + 30 * DAY));
		expect(summary(full)).toEqual([
			[0, "", null, null],
			[1, "", "current", null],
		]);
		expect(full[0]?.deletable).toBe(true);
	});

	it("0 → 1 → 2,2 是从第 0 代重新迁移的:未满时 0(来源)与 1(上一代)都锁;满了都可删", async () => {
		await makeZero();
		await makeGen("1", { source: { kind: "zero" }, createdAt: iso(CREATED - 40 * DAY) });
		await makeGen("2", { source: { kind: "zero" } });
		const early = await listGenerationUsage(opts(2, CREATED + 10 * DAY));
		expect(summary(early)).toEqual([
			[0, "", "protected-source", iso(CREATED + 30 * DAY)],
			[1, "", "protected-previous", iso(CREATED + 30 * DAY)],
			[2, "", "current", null],
		]);
		const full = await listGenerationUsage(opts(2, CREATED + 31 * DAY));
		expect(summary(full)).toEqual([
			[0, "", null, null],
			[1, "", null, null],
			[2, "", "current", null],
		]);
	});

	it("来源是 empty:只有上一代受时间保护,更早的(含第 0 代)当场可删", async () => {
		await makeZero();
		await makeGen("1");
		await makeGen("2");
		await makeGen("3", { source: { kind: "empty" } });
		const list = await listGenerationUsage(opts(3, CREATED + DAY));
		expect(summary(list)).toEqual([
			[0, "", null, null],
			[1, "", null, null],
			[2, "", "protected-previous", iso(CREATED + 30 * DAY)],
			[3, "", "current", null],
		]);
	});

	it("写到一半的 .partial 不许删,哪怕再老;同号的完整代照常判", async () => {
		await makeGen("1");
		await makeGen("2.partial", { noFile: true });
		await makeGen("3");
		const list = await listGenerationUsage(opts(3, CREATED + 99 * DAY));
		expect(summary(list)).toEqual([
			[1, "", null, null],
			[2, "partial", "partial", null],
			[3, "", "current", null],
		]);
		expect(list[1]?.formatVersion).toBeNull();
		expect(list[1]?.createdBy).toBeNull();
	});

	it("格式版本比这一版新的不许删(newer-format),与年龄无关", async () => {
		await makeGen("1");
		await makeGen("2", { formatVersion: 2, createdBy: "2.0.0" });
		const list = await listGenerationUsage(opts(1, CREATED + 99 * DAY));
		expect(summary(list)).toEqual([
			[1, "", "current", null],
			[2, "", "newer-format", null],
		]);
		expect(list[1]?.formatVersion).toBe(2);
		expect(list[1]?.createdBy).toBe("2.0.0");
	});

	it("generation.json 读不懂 / 缺了的代不许删(unreadable),照列出,版本与最后使用时间留空", async () => {
		await makeGen("1", { raw: "{ 不是 json" });
		await makeGen("2", { noFile: true });
		await makeGen("3", { raw: JSON.stringify({ formatVersion: "x" }) });
		await writeFile(join(host, "generations", "1", "data.bin"), "12345");
		await makeGen("4");
		const list = await listGenerationUsage(opts(4, CREATED + 99 * DAY));
		expect(summary(list)).toEqual([
			[1, "", "unreadable", null],
			[2, "", "unreadable", null],
			[3, "", "unreadable", null],
			[4, "", "current", null],
		]);
		expect(list[0]).toMatchObject({
			formatVersion: null,
			createdBy: null,
			lastActiveAt: null,
			deletable: false,
		});
		expect(list[0]?.sizeBytes).toBe(Buffer.byteLength("{ 不是 json") + 5);
	});

	it("当前代自己的 createdAt 读不到:其余的代一律当作没满、全部锁住(current-age-unknown)", async () => {
		await makeZero();
		await makeGen("1");
		await makeGen("2", { raw: "坏的" });
		const list = await listGenerationUsage(opts(2, CREATED + 999 * DAY));
		expect(summary(list)).toEqual([
			[0, "", "current-age-unknown", null],
			[1, "", "current-age-unknown", null],
			[2, "", "current", null],
		]);
	});

	it("当前序号在盘上根本找不到(不该发生)同样全锁", async () => {
		await makeGen("1");
		const list = await listGenerationUsage(opts(5, CREATED + 999 * DAY));
		expect(summary(list)).toEqual([[1, "", "current-age-unknown", null]]);
	});

	it("字段:版本 / createdBy / lastActiveAt 原样给;第 0 代是 0.x 且没有最后使用时间", async () => {
		await makeZero();
		await makeGen("1", { createdBy: "1.0.0-alpha.1", lastActiveAt: "2026-10-05T01:02:03.000Z" });
		const [zero, one] = await listGenerationUsage(opts(1, CREATED));
		expect(zero).toMatchObject({
			seq: 0,
			current: false,
			partial: false,
			formatVersion: null,
			createdBy: "0.x",
			lastActiveAt: null,
		});
		expect(one).toMatchObject({
			seq: 1,
			current: true,
			formatVersion: 1,
			createdBy: "1.0.0-alpha.1",
			lastActiveAt: "2026-10-05T01:02:03.000Z",
		});
	});

	it("第 0 代不存在就不列;generations/ 里认不得的名字(pending.json、残骸)不当代", async () => {
		await makeGen("1");
		await writeFile(join(host, "generations", "pending.json"), "{}");
		await mkdir(join(host, "generations", "2.bn-tmp.1.abc"));
		const list = await listGenerationUsage(opts(1, CREATED));
		expect(summary(list)).toEqual([[1, "", "current", null]]);
	});
});

describe("大小", () => {
	it("硬链接的文件计入 sizeBytes、不计入 reclaimableBytes;独占的两个都计", async () => {
		const one = await makeGen("1");
		const two = await makeGen("2");
		await writeFile(join(one, "shared.bin"), "x".repeat(100));
		await link(join(one, "shared.bin"), join(two, "shared.bin"));
		await mkdir(join(one, "sub"));
		await writeFile(join(one, "sub", "own.bin"), "y".repeat(10));
		const [g1] = await listGenerationUsage(opts(2, CREATED));
		const metaSize = (await stat(join(one, GENERATION_FILE))).size;
		expect(g1?.sizeBytes).toBe(100 + 10 + metaSize);
		expect(g1?.reclaimableBytes).toBe(10 + metaSize);
	});

	it("不跟符号链接:指到目录外的链接不把外面的东西算进来", async () => {
		const one = await makeGen("1");
		const outside = join(host, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "big.bin"), "z".repeat(1000));
		await symlink(outside, join(one, "link"));
		await makeGen("2");
		const [g1] = await listGenerationUsage(opts(2, CREATED));
		expect(g1?.sizeBytes).toBeLessThan(1000);
	});

	it("第 0 代只算 ZERO_GENERATION_LAYOUT 的键:versions/ logs/ generations/ 与别的杂物不算", async () => {
		await makeZero(); // state/globals.json = 2 字节
		await writeFile(join(host, "card-bg-cursors.json"), "abc"); // 文件键,3 字节
		await mkdir(join(host, "versions"));
		await writeFile(join(host, "versions", "payload.bin"), "v".repeat(500));
		await mkdir(join(host, "logs"));
		await writeFile(join(host, "logs", "2026-10-01.jsonl"), "l".repeat(500));
		await writeFile(join(host, "bn.config.yaml"), "c".repeat(500));
		await makeGen("1");
		const [zero] = await listGenerationUsage(opts(1, CREATED));
		expect(zero?.seq).toBe(0);
		expect(zero?.sizeBytes).toBe(5);
		expect(zero?.reclaimableBytes).toBe(5);
	});

	it("遍历不阻塞事件循环:量的过程中让出过事件循环(逐层异步读)", async () => {
		const root = join(host, "tree");
		for (let d = 0; d < 3; d++) {
			const sub = join(root, `d${d}`);
			await mkdir(sub, { recursive: true });
			// 第一个目录放 STAT_BATCH + 1 = 65 个文件,覆盖分批那条路;其余放 2 个
			const n = d === 0 ? 65 : 2;
			await Promise.all(Array.from({ length: n }, (_, i) => writeFile(join(sub, `f${i}`), "a")));
		}
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		const size = await measureTree(root);
		expect(size.size).toBe(69);
		expect(yielded).toBe(true);
	});
});

describe("删除", () => {
	const track = () => vi.fn((_task: Promise<unknown>) => {});

	it("可删的代:目录没了、回腾出的字节(= reclaimableBytes)、别的代原样、removeDirectory 的活登记进 track", async () => {
		await makeGen("1");
		const two = await makeGen("2");
		const three = await makeGen("3");
		await writeFile(join(host, "generations", "1", "a.bin"), "q".repeat(40));
		await link(join(host, "generations", "1", "a.bin"), join(three, "a.bin"));
		await writeFile(join(host, "generations", "1", "b.bin"), "q".repeat(7));
		const t = track();
		const before = (await listGenerationUsage(opts(3, CREATED + 99 * DAY))).find(
			(g) => g.seq === 1,
		);
		const result = await removeGeneration({ ...opts(3, CREATED + 99 * DAY), track: t }, 1);
		expect(result).toEqual({ kind: "removed", freedBytes: before?.reclaimableBytes });
		expect(before?.reclaimableBytes).toBeGreaterThan(7);
		expect(existsSync(join(host, "generations", "1"))).toBe(false);
		expect(existsSync(two) && existsSync(three)).toBe(true);
		expect(await readdir(join(host, "generations"))).toEqual(["2", "3"]);
		expect(t).toHaveBeenCalledOnce();
	});

	it("被锁的拒绝(带原因),盘上原封不动:当前代、受保护的、partial、新格式、读不懂", async () => {
		await makeZero();
		await makeGen("1", { raw: "坏" });
		await makeGen("2.partial", { noFile: true });
		await makeGen("3", { formatVersion: 2 });
		await makeGen("4", { source: { kind: "zero" } });
		const t = track();
		const now = CREATED + DAY;
		const expected: [number, string][] = [
			[0, "protected-source"],
			[1, "unreadable"],
			[2, "partial"],
			[3, "newer-format"],
			[4, "current"],
		];
		const snapshot = async () => (await readdir(host, { recursive: true })).sort();
		const before = await snapshot();
		for (const [seq, reason] of expected) {
			expect(await removeGeneration({ ...opts(4, now), track: t }, seq), `seq ${seq}`).toEqual({
				kind: "locked",
				reason,
			});
		}
		expect(await snapshot()).toEqual(before);
		expect(t).not.toHaveBeenCalled();
	});

	it("没有这一代 → not_found(含只剩 .partial 的号以外的一切不存在的号);超出范围的大号也只是 not_found", async () => {
		await makeGen("1");
		const result = await removeGeneration({ ...opts(1, CREATED), track: track() }, 7);
		expect(result).toEqual({ kind: "not_found" });
		expect(await removeGeneration({ ...opts(1, CREATED), track: track() }, 0)).toEqual({
			kind: "not_found",
		});
	});

	it("删第 0 代:只删 ZERO_GENERATION_LAYOUT 的键,versions/ logs/ generations/ 与 bn.config.yaml 一个字节不动", async () => {
		await makeZero();
		await writeFile(join(host, "card-bg-cursors.json"), "abc");
		await mkdir(join(host, "secrets"));
		await writeFile(join(host, "secrets", "master.key"), "k");
		await mkdir(join(host, "versions"));
		await writeFile(join(host, "versions", "p.bin"), "v");
		await mkdir(join(host, "logs"));
		await writeFile(join(host, "bn.config.yaml"), "c");
		await makeGen("1", { source: { kind: "empty" } });
		const result = await removeGeneration({ ...opts(1, CREATED + 99 * DAY), track: track() }, 0);
		expect(result).toEqual({ kind: "removed", freedBytes: 2 + 3 + 1 });
		expect((await readdir(host)).sort()).toEqual([
			"bn.config.yaml",
			"generations",
			"logs",
			"versions",
		]);
		expect(existsSync(join(host, "generations", "1", GENERATION_FILE))).toBe(true);
		// 再删一次:第 0 代已经不在了。
		expect(await removeGeneration({ ...opts(1, CREATED + 99 * DAY), track: track() }, 0)).toEqual({
			kind: "not_found",
		});
	});

	it("第 0 代被删到一半(只剩一部分键):仍列为第 0 代,再删一次删干净", async () => {
		await makeZero();
		await mkdir(join(host, "secrets"));
		await makeGen("1");
		// 模拟上次删到一半被杀:state 已经没了,只剩 secrets。
		await rm(join(host, "state"), { recursive: true });
		const list = await listGenerationUsage(opts(1, CREATED + 99 * DAY));
		expect(summary(list)).toEqual([
			[0, "", null, null],
			[1, "", "current", null],
		]);
		await removeGeneration({ ...opts(1, CREATED + 99 * DAY), track: track() }, 0);
		expect((await readdir(host)).sort()).toEqual(["generations"]);
	});
});

describe("删到一半的残骸由开机清扫收走", () => {
	it("generations/ 这一层与宿主根上第 0 代键的 .bn-tmp 残骸被收走;正常的代、代内部的残留、宿主根上别的东西一概不碰", async () => {
		const one = await makeGen("1");
		await writeFile(join(one, "x.json.bn-tmp.1.abc"), "旧代内部的残留");
		await mkdir(join(host, "generations", "2.bn-tmp.1.abc", "deep"), { recursive: true });
		await writeFile(join(host, "generations", "2.bn-tmp.1.abc", "deep", "f"), "半截");
		await mkdir(join(host, "generations", "3.partial.bn-tmp.9.ff"));
		await mkdir(join(host, "state.bn-tmp.1.abc"));
		await writeFile(join(host, "card-bg-cursors.json.bn-tmp.1.abc"), "x");
		// 不碰的:
		await writeFile(join(host, "bn.config.yaml.bn-tmp.1.abc"), "别人的临时文件");
		await mkdir(join(host, "versions"));
		await writeFile(join(host, "versions", "a.bn-tmp.1.abc"), "versions 另有人扫");
		await writeFile(join(host, "generations", "notes.bn-tmp.1.abc"), "名字不是代");
		await writeFile(join(host, "generations", "pending.json"), "{}");

		const report = await sweepGenerationLeftovers(host);

		expect(report.removed.map((p) => p.slice(host.length + 1)).sort()).toEqual([
			"card-bg-cursors.json.bn-tmp.1.abc",
			"generations/2.bn-tmp.1.abc",
			"generations/3.partial.bn-tmp.9.ff",
			"state.bn-tmp.1.abc",
		]);
		expect((await readdir(host)).sort()).toEqual([
			"bn.config.yaml.bn-tmp.1.abc",
			"generations",
			"versions",
		]);
		expect((await readdir(join(host, "generations"))).sort()).toEqual([
			"1",
			"notes.bn-tmp.1.abc",
			"pending.json",
		]);
		expect(existsSync(join(one, "x.json.bn-tmp.1.abc"))).toBe(true);
		expect(existsSync(join(one, GENERATION_FILE))).toBe(true);
		expect(existsSync(join(host, "versions", "a.bn-tmp.1.abc"))).toBe(true);
	});

	it("开代开到一半被杀留下的 <序号>.partial 整个收走,不管这次开机用旧代还是开新代", async () => {
		// 重新迁移迁到一半被杀:标记已经取走,下次开机接着用原来那一代,没有人再开新代去顺手清它。
		const one = await makeGen("1");
		await mkdir(join(host, "generations", "2.partial", "history"), { recursive: true });
		await writeFile(join(host, "generations", "2.partial", "history", "f.jsonl"), "半截");
		await writeFile(join(host, "generations", "notes.partial"), "名字不是代");

		const report = await sweepGenerationLeftovers(host);

		expect(report.removed.map((p) => p.slice(host.length + 1))).toEqual(["generations/2.partial"]);
		expect((await readdir(join(host, "generations"))).sort()).toEqual(["1", "notes.partial"]);
		expect(existsSync(join(one, GENERATION_FILE))).toBe(true);
	});

	it("宿主根或 generations/ 不存在也不抛", async () => {
		const report = await sweepGenerationLeftovers(join(host, "nowhere"));
		expect(report).toEqual({ removed: [], restored: [], skipped: [] });
	});
});
