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

// 载荷里的说明(打包时从 CHANGELOG 抽的那份);夹具里这一代是 1.0.0 开出的。
const NOTES = [
	{ version: "1.0.0", summary: "第一版" },
	{ version: "1.0.1", date: "2026-10-20", summary: "修了点东西" },
	{ version: "1.1.0", summary: "**新功能**", caution: "⚠️ 先停掉旧任务" },
	{ version: "1.2.0", summary: "再来一版" },
];
const releaseUrl = (v: string) => `https://github.com/Akokk0/bilibili-notify/releases/tag/v${v}`;

const open = (runningVersion = "1.0.0", releaseNotes = NOTES) =>
	createSystemNoticeStore({ dir, runningVersion, releaseNotes });

describe("记一条、读清单", () => {
	it("记下的带 id 与时刻,清单里按先后给出;generation.json 别的格原样留着", async () => {
		const store = open();
		const migrated = await store.append({
			kind: "migrated",
			cardSkinsDropped: true,
			masterTargetCleared: true,
		});
		const failed = await store.append({
			kind: "generation-failed",
			source: "zero",
			message: "disk full",
		});

		expect(migrated).toMatchObject({
			kind: "migrated",
			cardSkinsDropped: true,
			masterTargetCleared: true,
		});
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
		await store.append({ kind: "migrated", cardSkinsDropped: false, masterTargetCleared: false });
		expect((await readRaw()).notices[0]).toEqual(future);
	});
});

describe("看过了", () => {
	it("记 acknowledgedAt,清单里不再有它;别的照旧", async () => {
		const store = open();
		const a = await store.append({
			kind: "migrated",
			cardSkinsDropped: false,
			masterTargetCleared: false,
		});
		const b = await store.append({ kind: "rolled-back", version: "1.0.1" });

		expect(await store.acknowledge(a.id)).toBe(true);

		expect(await store.list()).toEqual([b]);
		const entry = (await readRaw()).notices.find((n: { id: string }) => n.id === a.id);
		expect(Number.isNaN(Date.parse(entry.acknowledgedAt))).toBe(false);
	});

	it("没有这一条 → false,盘上不动", async () => {
		const store = open();
		await store.append({ kind: "migrated", cardSkinsDropped: false, masterTargetCleared: false });
		const before = await readFile(generationFile(), "utf8");

		expect(await store.acknowledge("no-such-id")).toBe(false);
		expect(await readFile(generationFile(), "utf8")).toBe(before);
	});

	it("连着标两条,两条都记上(写排队,不互相盖掉)", async () => {
		const store = open();
		const a = await store.append({
			kind: "migrated",
			cardSkinsDropped: false,
			masterTargetCleared: false,
		});
		const b = await store.append({ kind: "rolled-back", version: "1.0.1" });

		await Promise.all([store.acknowledge(a.id), store.acknowledge(b.id)]);

		expect(await store.list()).toEqual([]);
	});
});

describe("升级之后的「本次更新」", () => {
	const updatedOf = async (store = open()) =>
		(await store.list()).flatMap((n) => (n.kind === "updated" ? [n] : []));

	it("正在跑的比这一代开出时的新 → 记一条 updated,带跨过的各版说明(新的在前、每条带发布页地址)", async () => {
		await open("1.1.0").recordUpdate();

		const [notice, ...rest] = await updatedOf(open("1.1.0"));
		expect(rest).toEqual([]);
		expect(notice).toMatchObject({ kind: "updated", version: "1.1.0" });
		expect(notice?.releases).toEqual([
			{
				version: "1.1.0",
				summary: "**新功能**",
				caution: "⚠️ 先停掉旧任务",
				releaseUrl: releaseUrl("1.1.0"),
			},
			{
				version: "1.0.1",
				date: "2026-10-20",
				summary: "修了点东西",
				releaseUrl: releaseUrl("1.0.1"),
			},
		]);
	});

	it("开出这一代的就是正在跑的这一版(新装、全新开始、刚迁完)→ 不记,盘上不动", async () => {
		const before = await readFile(generationFile(), "utf8");
		await open("1.0.0").recordUpdate();

		expect(await open("1.0.0").list()).toEqual([]);
		expect(await readFile(generationFile(), "utf8")).toBe(before);
	});

	it("开发版 → 什么都不记、什么都不写", async () => {
		const before = await readFile(generationFile(), "utf8");
		await open("0.0.0-dev").recordUpdate();
		await open("dev").recordUpdate();

		expect(await readFile(generationFile(), "utf8")).toBe(before);
	});

	it("一样或更旧(被退回、手动回退)→ 不记", async () => {
		const before = await readFile(generationFile(), "utf8");
		await open("0.12.0").recordUpdate();

		expect(await readFile(generationFile(), "utf8")).toBe(before);
	});

	it("同一版再开机不再多记;跑过的最高版本只往高走:升到 1.1 又退回 1.0.1 再升回 1.1 不再弹", async () => {
		await open("1.1.0").recordUpdate();
		await open("1.1.0").recordUpdate();
		const [first] = await updatedOf(open("1.1.0"));
		if (!first) throw new Error("expected an updated notice");
		await open("1.1.0").acknowledge(first.id);

		await open("1.0.1").recordUpdate();
		await open("1.1.0").recordUpdate();

		expect(await updatedOf(open("1.1.0"))).toEqual([]);
		const stored = (await readRaw()).notices.filter((n: { kind: string }) => n.kind === "updated");
		expect(stored).toHaveLength(1);
	});

	it("清单里只给不比正在跑的新的那条 updated:退回旧版后暂时不给,再升回来又给", async () => {
		await open("1.1.0").recordUpdate();

		expect(await updatedOf(open("1.0.1"))).toEqual([]);
		expect(await updatedOf(open("1.1.0"))).toHaveLength(1);
	});

	it("还没看过的旧 updated → 新的那条从旧的那条的起点算起,旧的标看过,面板只看到一条", async () => {
		await open("1.1.0").recordUpdate();
		await open("1.2.0").recordUpdate();

		const notices = await updatedOf(open("1.2.0"));
		expect(notices).toHaveLength(1);
		expect(notices[0]?.version).toBe("1.2.0");
		expect(notices[0]?.releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.0", "1.0.1"]);
		const stored = (await readRaw()).notices.filter((n: { kind: string }) => n.kind === "updated");
		expect(stored).toHaveLength(2);
		expect(typeof stored[0].acknowledgedAt).toBe("string");
		expect(stored[1].acknowledgedAt).toBeUndefined();
	});

	it("旧的 updated 已经看过 → 新的那条只从旧的那条的版本之后算起", async () => {
		await open("1.1.0").recordUpdate();
		const [old] = await updatedOf(open("1.1.0"));
		if (!old) throw new Error("expected an updated notice");
		await open("1.1.0").acknowledge(old.id);

		await open("1.2.0").recordUpdate();

		const notices = await updatedOf(open("1.2.0"));
		expect(notices.map((n) => n.releases.map((r) => r.version))).toEqual([["1.2.0"]]);
	});

	it("连着调两次(写排队)只记一条;generation.json 别的格原样留着", async () => {
		const store = open("1.1.0");
		await Promise.all([store.recordUpdate(), store.recordUpdate()]);

		expect(await updatedOf(store)).toHaveLength(1);
		const raw = await readRaw();
		expect(raw.addedLater).toEqual({ x: 1 });
		expect(raw.createdBy).toBe("1.0.0");
	});

	it("载荷里没有说明(数据文件缺了)→ 照记,releases 是空表", async () => {
		await open("1.1.0", []).recordUpdate();

		const [notice] = await updatedOf(open("1.1.0", []));
		expect(notice).toMatchObject({ version: "1.1.0", releases: [] });
	});
});

describe("migrated 在线上带版本与说明", () => {
	it("带开出这一代的版本与 1.0 起到它为止的说明;盘上那条不多出格", async () => {
		const store = open("1.0.0");
		const migrated = await store.append({
			kind: "migrated",
			cardSkinsDropped: false,
			masterTargetCleared: false,
		});

		expect(migrated).toMatchObject({ kind: "migrated", version: "1.0.0" });
		if (migrated.kind !== "migrated") throw new Error("expected migrated");
		expect(migrated.releases).toEqual([
			{ version: "1.0.0", summary: "第一版", releaseUrl: releaseUrl("1.0.0") },
		]);
		const [onDisk] = (await readRaw()).notices;
		expect(onDisk.version).toBeUndefined();
		expect(onDisk.releases).toBeUndefined();
	});

	it("说明是读清单那一刻现补的:同一条在不同的载荷下给出不同的说明", async () => {
		await open("1.0.0", []).append({
			kind: "migrated",
			cardSkinsDropped: false,
			masterTargetCleared: false,
		});

		const [withNotes] = await open("1.0.0").list();
		expect(withNotes).toMatchObject({ releases: [{ version: "1.0.0" }] });
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
