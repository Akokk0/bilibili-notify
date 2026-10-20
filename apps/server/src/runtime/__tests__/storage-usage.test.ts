/**
 * 「存储占用」的用量表(㉙d,ADR-0027 决策 10 / 17):每类各放一点东西,每行数字手写对账。
 *
 * 图的分类只看 `holders`:全都属于「推送历史 / 重推原件」→ 历史图;只有「女仆对话」→ 女仆 AI;其余(没人引用、
 * 被订阅资料引用、同时被两类引用)→ 其它图片。三个图类加起来必须等于 `images/` 目录的总大小。
 * 数据根目录表里每个键要么被某一类覆盖、要么在写明理由的「不进表」清单里 —— 往数据根加目录忘了想归哪类会红。
 */

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	FRESH_MTIME,
	makeStorageWorld,
	type StorageWorld,
} from "../../__tests__/support/storage-world.js";
import { IMAGE_REFERRERS } from "../../images/image-referrers.js";
import type { ImageUsage } from "../../images/image-store.js";
import { DATA_ROOT_LAYOUT } from "../roots.js";
import {
	CLEARABLE_STORAGE_CATEGORIES,
	classifyImage,
	DATA_ROOT_STORAGE_COVERAGE,
	sumImageBytes,
} from "../storage-usage.js";

const H = IMAGE_REFERRERS;

describe("classifyImage:一张图属于哪一类只看引用方", () => {
	it.each([
		[[], "otherImages"],
		[[H.history], "historyImages"],
		[[H.repush], "historyImages"],
		[[H.history, H.repush], "historyImages"],
		[[H.chat], "ai"],
		[[H.profiles], "otherImages"],
		[[H.posts], "otherImages"],
		[[H.live], "otherImages"],
		[[H.sourceDeclared], "otherImages"],
		[[H.history, H.sourceDeclared], "otherImages"],
		[[H.history, H.chat], "otherImages"],
		[[H.history, H.profiles], "otherImages"],
		[[H.repush, H.chat], "otherImages"],
		[[H.chat, H.chat], "ai"],
	] as const)("%j → %s", (holders, expected) => {
		expect(classifyImage(holders)).toBe(expected);
	});
});

const text = (...lines: string[]) => `${lines.join("\n")}\n`;

let world: StorageWorld;
beforeEach(async () => {
	world = await makeStorageWorld();
});
afterEach(async () => {
	await world.dispose();
});

/** 摆好每一类各一点东西,回各自的期望字节数(手写)。 */
async function seed() {
	const w = world;
	// 数据统计:四个目录各一份(100 + 200 + 300 + 400),外加不在统计里的运行记录。
	await w.file("data", "stats/posts/a.jsonl", 100);
	await w.file("data", "stats/live/a.jsonl", 200);
	await w.file("data", "stats/recording/a.jsonl", 300);
	await w.file("data", "stats/followers/a.jsonl", 400);
	await w.file("data", "uptime/hours.jsonl", 7);

	// 图:H1 只被历史行引用,R1 只被重推原件引用,C1 只被对话引用,HC 同时被历史行与对话引用,
	// P1 被订阅资料引用,U1 没人引用(过了宽限期),F1 没人引用(宽限期内)。
	const h1 = await w.image(w.writers.history, 1);
	const r1 = await w.image(w.writers.repush, 2);
	const c1 = await w.image(w.writers.chat, 3);
	const hc = await w.image(w.writers.history, 4);
	const p1 = await w.image(w.writers.profiles, 5);
	const u1 = await w.image(w.writers.history, 6);
	const f1 = await w.image(w.writers.history, 7, FRESH_MTIME);
	w.profileRefs.push(p1.ref);

	// 推送历史的文字:两个日文件(一个引用 H1 与 HC),外加水位线(不算任何一类)。
	const day1 = text(
		JSON.stringify({ messages: [{ payload: { image: h1.ref } }] }),
		JSON.stringify({ messages: [{ payload: { image: hc.ref } }] }),
	);
	const day2 = text(JSON.stringify({ messages: [{ payload: { text: "x" } }] }));
	await w.write("data", "history/2026-10-05.jsonl", day1);
	await w.write("data", "history/2026-10-06.jsonl", day2);
	await w.write("data", "history/retention.json", `{"clearedThrough":"2026-10-01"}`);
	// 重推原件:一份引用 R1。
	const snapshot = JSON.stringify({ messages: [{ payload: { image: r1.ref } }] });
	await w.write("data", "history/repush/2026-10-05/row-1.json", snapshot);
	// 女仆对话:一份引用 C1 与 HC。
	const chat = JSON.stringify({ messages: [{ images: [c1.ref, hc.ref] }] });
	await w.write("data", "ai/conversations/c1.json", chat);
	// 日志在宿主根。
	await w.file("host", "logs/2026-10-05.jsonl", 33);

	w.generations.push(gen(1, true, 1000), gen(2, true, 2000), gen(3, false, 5000));
	return {
		day1: Buffer.byteLength(day1),
		day2: Buffer.byteLength(day2),
		snapshot: Buffer.byteLength(snapshot),
		chat: Buffer.byteLength(chat),
		img: {
			h1: h1.size,
			r1: r1.size,
			c1: c1.size,
			hc: hc.size,
			p1: p1.size,
			u1: u1.size,
			f1: f1.size,
		},
	};
}

function gen(seq: number, deletable: boolean, reclaimableBytes: number) {
	return {
		seq,
		current: false,
		partial: false,
		formatVersion: 1,
		createdBy: "1.0.0",
		lastActiveAt: null,
		deletable,
		lockReason: deletable ? null : ("protected-previous" as const),
		deletableAt: null,
		sizeBytes: reclaimableBytes * 2,
		reclaimableBytes,
	};
}

describe("用量表:每一行的数字", () => {
	it("每类各放一点东西,逐行对数;次序固定", async () => {
		const n = await seed();
		const { rows } = await world.storage.list();
		expect(rows).toEqual([
			{ category: "stats", sizeBytes: 100 + 200 + 300 + 400, clearable: true },
			// 水位线 retention.json 与 repush/ 目录都不在文字这一行里。
			{ category: "historyText", sizeBytes: n.day1 + n.day2, clearable: true },
			// 历史图 = 只被历史行 / 重推原件引用的图(H1、R1) + 重推原件文件本身。
			{
				category: "historyImages",
				sizeBytes: n.img.h1 + n.img.r1 + n.snapshot,
				clearable: true,
			},
			// 女仆 AI = 对话文件 + 只被对话引用的图(C1);同时被历史引用的 HC 不算。
			{ category: "ai", sizeBytes: n.chat + n.img.c1, clearable: true },
			// 旧版本数据只算可删的两代的 reclaimableBytes(1000 + 2000),锁着的那代(5000)不算。
			{ category: "generations", sizeBytes: 3000, clearable: false, deletableGenerations: 2 },
			// 其它图片 = HC(两类共用)、P1(订阅资料)、U1(没人引用)、F1(宽限期内)。
			{
				category: "otherImages",
				sizeBytes: n.img.hc + n.img.p1 + n.img.u1 + n.img.f1,
				clearable: false,
			},
			{ category: "logs", sizeBytes: 33, clearable: false },
		]);
	});

	it("什么都没有:七行都是 0", async () => {
		const { rows } = await world.storage.list();
		expect(rows.map((r) => [r.category, r.sizeBytes])).toEqual([
			["stats", 0],
			["historyText", 0],
			["historyImages", 0],
			["ai", 0],
			["generations", 0],
			["otherImages", 0],
			["logs", 0],
		]);
	});

	it("只有锁着的旧代:generations 是 0 字节、0 代可删", async () => {
		world.generations.push(gen(3, false, 5000));
		const row = (await world.storage.list()).rows.find((r) => r.category === "generations");
		expect(row).toEqual({
			category: "generations",
			sizeBytes: 0,
			clearable: false,
			deletableGenerations: 0,
		});
	});

	it("三个图类加起来等于图库目录的总大小", async () => {
		await seed();
		const usage: ImageUsage[] = await world.imageStore.usage();
		const sums = sumImageBytes(usage);
		const onDisk = await world.bytesIn(`${world.dataRoot}/images`);
		expect(sums.historyImages + sums.ai + sums.otherImages).toBe(onDisk);
		expect(onDisk).toBeGreaterThan(0);
	});
});

describe("守卫:数据根的目录表每个键都想过归哪一类", () => {
	it("每个键要么被某一类覆盖,要么在写明理由的『不进表』清单里", () => {
		const covered = new Set<string>();
		for (const key of Object.keys(DATA_ROOT_LAYOUT)) {
			const entry = (DATA_ROOT_STORAGE_COVERAGE as Record<string, unknown>)[key];
			expect(
				entry,
				`数据根的 ${key} 没有归类:加进存储占用的某一类,或写明为什么不进表`,
			).toBeDefined();
			if (typeof entry === "object" && entry !== null && "excluded" in entry) {
				expect((entry as { excluded: string }).excluded.trim().length).toBeGreaterThan(5);
			} else {
				const categories = Array.isArray(entry) ? entry : [entry];
				expect(categories.length).toBeGreaterThan(0);
				for (const c of categories) covered.add(c as string);
			}
		}
		// 反过来:表里没有已经不存在的键。
		for (const key of Object.keys(DATA_ROOT_STORAGE_COVERAGE)) {
			expect(Object.keys(DATA_ROOT_LAYOUT), `${key} 不在数据根的目录表里了`).toContain(key);
		}
		// 四个可清的类别都有某个目录在管它。
		for (const category of CLEARABLE_STORAGE_CATEGORIES) {
			expect(covered.has(category), `${category} 没有对应的目录`).toBe(true);
		}
	});

	it("不进表的清单正好是主人定的那八个,images 由三个图类覆盖", () => {
		const excluded = Object.entries(DATA_ROOT_STORAGE_COVERAGE)
			.filter(([, v]) => typeof v === "object" && !Array.isArray(v))
			.map(([k]) => k)
			.sort();
		expect(excluded).toEqual(
			[
				"config",
				"extensions",
				"library",
				"maid-skills",
				"runtime",
				"secrets",
				"skins",
				"uptime",
			].sort(),
		);
		expect(DATA_ROOT_STORAGE_COVERAGE.images).toEqual(["historyImages", "ai", "otherImages"]);
	});
});
