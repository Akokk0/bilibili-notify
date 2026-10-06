import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { storageWriteGate } from "../../__tests__/support/storage-write-gate.js";
import { DATA_ROOT_LAYOUT } from "../../runtime/roots.js";
import { createUptimeStore, sumUptimeByHour, type UptimeEntry } from "../store.js";

vi.mock("@bilibili-notify/storage", async (importOriginal) => {
	const { gateStorageWrites } = await import("../../__tests__/support/storage-write-gate.js");
	return gateStorageWrites(await importOriginal<typeof import("@bilibili-notify/storage")>());
});

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
} as unknown as Logger;

let dataRoot: string;
const file = () => join(dataRoot, "uptime", "hours.jsonl");

beforeEach(async () => {
	storageWriteGate.reset();
	dataRoot = await mkdtemp(join(tmpdir(), "bn-uptime-store-"));
});
afterEach(async () => {
	storageWriteGate.reset();
	await rm(dataRoot, { recursive: true, force: true });
});

const H8: UptimeEntry = { hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 40 };
const H9: UptimeEntry = { hourStartedAt: "2026-10-06T09:00:00.000Z", minutes: 60 };

describe("运行记录的仓", () => {
	it("目录表里有 uptime 这一项", () => {
		expect(Object.keys(DATA_ROOT_LAYOUT)).toContain("uptime");
	});

	it("追加、读回:按落盘顺序,sinceIso 之前的小时不读", async () => {
		const store = createUptimeStore({ dataRoot, logger });
		await store.append(H8);
		await store.append(H9);
		expect(await store.list()).toEqual([H8, H9]);
		expect(await store.list("2026-10-06T09:00:00.000Z")).toEqual([H9]);
		const lines = (await readFile(file(), "utf8")).trim().split("\n");
		expect(lines.map((l) => JSON.parse(l))).toEqual([H8, H9]);
	});

	it("没有文件就是空,构造与读都不碰盘", async () => {
		const store = createUptimeStore({ dataRoot, logger });
		expect(await store.list()).toEqual([]);
		await expect(readFile(file(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("坏行跳过:不是 JSON、缺格、分钟越界或不是整数、时刻不是时刻", async () => {
		await mkdir(join(dataRoot, "uptime"), { recursive: true });
		await appendFile(
			file(),
			[
				JSON.stringify(H8),
				"{not json",
				JSON.stringify({ hourStartedAt: H9.hourStartedAt }),
				JSON.stringify({ hourStartedAt: H9.hourStartedAt, minutes: 61 }),
				JSON.stringify({ hourStartedAt: H9.hourStartedAt, minutes: -1 }),
				JSON.stringify({ hourStartedAt: H9.hourStartedAt, minutes: 1.5 }),
				JSON.stringify({ hourStartedAt: "昨天", minutes: 5 }),
				JSON.stringify(H9),
				"",
			].join("\n"),
		);
		const store = createUptimeStore({ dataRoot, logger });
		expect(await store.list()).toEqual([H8, H9]);
	});

	it("只写这两格:多带的东西不进盘", async () => {
		const store = createUptimeStore({ dataRoot, logger });
		await store.append({ ...H8, extra: 1 } as UptimeEntry);
		expect(JSON.parse((await readFile(file(), "utf8")).trim())).toEqual(H8);
	});

	it("close 之后的写被拒且不碰盘", async () => {
		const store = createUptimeStore({ dataRoot, logger });
		await store.append(H8);
		const before = await readFile(file(), "utf8");
		await store.close();
		const writesAtClose = storageWriteGate.writes;

		await expect(store.append(H9)).rejects.toMatchObject({ code: "queue_closed" });
		expect(storageWriteGate.writes).toBe(writesAtClose);
		expect(await readFile(file(), "utf8")).toBe(before);
		expect(await store.list()).toEqual([H8]);
	});

	it("close 等在途的写落盘", async () => {
		const store = createUptimeStore({ dataRoot, logger });
		storageWriteGate.hold();
		const writing = store.append(H8);
		await storageWriteGate.arrived();
		let closed = false;
		const closing = store.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);
		storageWriteGate.release();
		await closing;
		await writing;
		expect(await readFile(file(), "utf8")).toContain(H8.hourStartedAt);
	});
});

describe("sumUptimeByHour", () => {
	it("同一小时的几行相加、封顶 60,按小时排序", () => {
		const rows: UptimeEntry[] = [
			{ hourStartedAt: "2026-10-06T09:00:00.000Z", minutes: 45 },
			{ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 10 },
			{ hourStartedAt: "2026-10-06T09:00:00.000Z", minutes: 45 },
			{ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 15 },
		];
		expect(sumUptimeByHour(rows)).toEqual([
			{ hourStartedAt: "2026-10-06T08:00:00.000Z", minutes: 25 },
			{ hourStartedAt: "2026-10-06T09:00:00.000Z", minutes: 60 },
		]);
	});
});
