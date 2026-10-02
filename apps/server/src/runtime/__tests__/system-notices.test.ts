/**
 * 开机之后要告诉主人的事(⑧;ADR-0022 决策 3 下 10-01 的 🔗):存在当前这代 `generation.json` 的 `notices` 里。
 *
 * - 记一条:带上 id 与时刻;generation.json 别的格(包括以后的版本加的)原样留着。
 * - 主人看过就记 `acknowledgedAt`,清单里不再有它。
 * - 读不懂的条目(以后的版本加的种类)清单里不给,但也不从盘上抹掉。
 * - 启动器判死的版本:比正在跑的新、还没记过的,各记一条「X 起不来」;清单里也只给比正在跑的新的。
 * - 写都排队:面板连点两下「看过了」,不会互相盖掉。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GENERATION_FILE } from "../generations.js";
import { createSystemNoticeStore } from "../system-notices.js";

let dir: string;
const generationFile = () => join(dir, GENERATION_FILE);
const readRaw = async () => JSON.parse(await readFile(generationFile(), "utf8"));

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-system-notices-"));
	await writeFile(
		generationFile(),
		JSON.stringify({
			formatVersion: 1,
			migrationRevision: 7,
			createdAt: "2026-10-01T00:00:00.000Z",
			createdBy: "1.0.0",
			lastActiveAt: "2026-10-01T00:00:00.000Z",
			source: { kind: "zero" },
			addedLater: { x: 1 },
		}),
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const open = (runningVersion = "1.0.0") => createSystemNoticeStore({ dir, runningVersion });

describe("记一条、读清单", () => {
	it("记下的带 id 与时刻,清单里按先后给出;generation.json 别的格原样留着", async () => {
		const store = open();
		const migrated = await store.append({ kind: "migrated", cardSkinsDropped: true });
		const failed = await store.append({
			kind: "generation-failed",
			source: "zero",
			message: "disk full",
		});

		expect(migrated).toMatchObject({ kind: "migrated", cardSkinsDropped: true });
		expect(typeof migrated.id).toBe("string");
		expect(migrated.id).not.toBe(failed.id);
		expect(Number.isNaN(Date.parse(migrated.createdAt))).toBe(false);
		expect(await store.list()).toEqual([migrated, failed]);

		const raw = await readRaw();
		expect(raw.addedLater).toEqual({ x: 1 });
		expect(raw.source).toEqual({ kind: "zero" });
	});

	it("一条都没记过 → 空清单", async () => {
		expect(await open().list()).toEqual([]);
	});

	it("读不懂的条目(以后的版本加的种类)清单里不给,再记一条时也不从盘上抹掉", async () => {
		const raw = await readRaw();
		const future = { id: "f1", createdAt: "2026-10-02T00:00:00.000Z", kind: "from-the-future" };
		await writeFile(generationFile(), JSON.stringify({ ...raw, notices: [future] }));
		const store = open();

		expect(await store.list()).toEqual([]);
		await store.append({ kind: "migrated", cardSkinsDropped: false });
		expect((await readRaw()).notices[0]).toEqual(future);
	});
});

describe("看过了", () => {
	it("记 acknowledgedAt,清单里不再有它;别的照旧", async () => {
		const store = open();
		const a = await store.append({ kind: "migrated", cardSkinsDropped: false });
		const b = await store.append({ kind: "rolled-back", version: "1.0.1" });

		expect(await store.acknowledge(a.id)).toBe(true);

		expect(await store.list()).toEqual([b]);
		const entry = (await readRaw()).notices.find((n: { id: string }) => n.id === a.id);
		expect(Number.isNaN(Date.parse(entry.acknowledgedAt))).toBe(false);
	});

	it("没有这一条 → false,盘上不动", async () => {
		const store = open();
		await store.append({ kind: "migrated", cardSkinsDropped: false });
		const before = await readFile(generationFile(), "utf8");

		expect(await store.acknowledge("no-such-id")).toBe(false);
		expect(await readFile(generationFile(), "utf8")).toBe(before);
	});

	it("连着标两条,两条都记上(写排队,不互相盖掉)", async () => {
		const store = open();
		const a = await store.append({ kind: "migrated", cardSkinsDropped: false });
		const b = await store.append({ kind: "rolled-back", version: "1.0.1" });

		await Promise.all([store.acknowledge(a.id), store.acknowledge(b.id)]);

		expect(await store.list()).toEqual([]);
	});
});

describe("启动器判死的版本", () => {
	it("比正在跑的新的各记一条;旧的、一样的不记;再记一遍不重复", async () => {
		const store = open("1.0.0");

		await store.recordRollbacks(["1.0.1", "0.12.0", "1.0.0", "1.1.0-alpha.1"]);
		await store.recordRollbacks(["1.0.1"]);

		const versions = (await store.list()).map((n) => (n.kind === "rolled-back" ? n.version : null));
		expect(versions).toEqual(["1.0.1", "1.1.0-alpha.1"]);
	});

	it("看过的那条不再记一遍", async () => {
		const store = open("1.0.0");
		await store.recordRollbacks(["1.0.1"]);
		const [notice] = await store.list();
		if (!notice) throw new Error("expected a notice");
		await store.acknowledge(notice.id);

		await store.recordRollbacks(["1.0.1"]);

		expect(await store.list()).toEqual([]);
	});

	it("那一版后来真跑起来了 → 清单里不再说它起不来", async () => {
		await open("1.0.0").recordRollbacks(["1.0.1"]);

		expect(await open("1.0.1").list()).toEqual([]);
		expect(await open("1.0.0").list()).toHaveLength(1);
	});
});
