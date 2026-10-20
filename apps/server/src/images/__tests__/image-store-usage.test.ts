import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";
import { IMAGE_REFERRERS } from "../image-referrers.js";
import { createImageStore, IMAGE_GRACE_MS, type ImageStore } from "../image-store.js";

/**
 * 图库的用量读口 `usage()`(㉙b,ADR-0027 决策 10 / 17):每张图的大小、修改时间与引用它的引用方名字;
 * 与 `sweep` 共用「收集各家引用」那一处,清扫的结果多一格 `removedBytes`。
 *
 * `stat` 套一层只计数不改行为的壳,用来钉「对 N 张图只 stat N 次」。
 */

const statCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		stat: ((...args: Parameters<typeof actual.stat>) => {
			statCalls.count += 1;
			return actual.stat(...args);
		}) as typeof actual.stat,
	};
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-06T00:00:00.000Z");
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** 字节数各不相同的几张 png(头一样、尾巴不同长度),大小断言才分得出谁是谁。 */
const png = (tail: number[]) => Uint8Array.from([...PNG_HEAD, ...tail]);
const A = png([1]);
const B = png([2, 2]);
const C = png([3, 3, 3]);
const D = png([4, 4, 4, 4]);

let dir: string;
let store: ImageStore;
const lists = { history: [] as string[], chat: [] as string[], profiles: [] as string[] };
let calls: Record<string, number>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-images-usage-"));
	store = createImageStore({ dir });
	calls = {};
	lists.history = [];
	lists.chat = [];
	lists.profiles = [];
	statCalls.count = 0;
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function registerThree() {
	const referrerOf = (name: string, source: () => string[]) =>
		store.register({
			name,
			listRefs: async () => {
				calls[name] = (calls[name] ?? 0) + 1;
				return source();
			},
		});
	const history = referrerOf(IMAGE_REFERRERS.history, () => lists.history);
	referrerOf(IMAGE_REFERRERS.chat, () => lists.chat);
	referrerOf(IMAGE_REFERRERS.profiles, () => lists.profiles);
	return history;
}

async function put(writer: ReturnType<typeof registerThree>, bytes: Uint8Array): Promise<string> {
	const result = await writer.put(bytes);
	if (!result.ok) throw new Error(result.message);
	return result.ref;
}

async function age(ref: string, ms: number) {
	const when = new Date(NOW.getTime() - ms);
	await utimes(join(dir, ref), when, when);
}

describe("usage", () => {
	it("每张图回大小、修改时间与引用它的引用方(只一家 / 两家 / 没人 / 宽限期内的新图)", async () => {
		const writer = registerThree();
		const a = await put(writer, A);
		const b = await put(writer, B);
		const c = await put(writer, C);
		const d = await put(writer, D);
		for (const ref of [a, b, c]) await age(ref, 10 * DAY);
		// d 留在「刚存」的宽限期里,而且已经有人引用。
		lists.history = [a, b, d];
		lists.chat = [b];

		const usage = await store.usage();

		const byRef = new Map(usage.map((row) => [row.ref, row]));
		expect(usage).toHaveLength(4);
		expect(byRef.get(a)?.holders).toEqual([IMAGE_REFERRERS.history]);
		expect(byRef.get(b)?.holders).toEqual([IMAGE_REFERRERS.history, IMAGE_REFERRERS.chat]);
		expect(byRef.get(c)?.holders).toEqual([]);
		expect(byRef.get(d)?.holders).toEqual([IMAGE_REFERRERS.history]);
		const expected: [string, Uint8Array][] = [
			[a, A],
			[b, B],
			[c, C],
			[d, D],
		];
		for (const [ref, bytes] of expected) {
			const row = byRef.get(ref);
			const real = await stat(join(dir, ref));
			expect(row?.sizeBytes).toBe(bytes.byteLength);
			expect(row?.sizeBytes).toBe(real.size);
			expect(row?.modifiedAt).toBe(real.mtimeMs);
		}
	});

	it("目录还没建时是空表", async () => {
		registerThree();
		await rm(dir, { recursive: true, force: true });
		expect(await store.usage()).toEqual([]);
	});

	it("图库目录里不是图库的文件不算", async () => {
		const writer = registerThree();
		await put(writer, A);
		await writeFile(join(dir, "README.txt"), "别人放的");
		expect(await store.usage()).toHaveLength(1);
	});

	it("一家 listRefs 抛错:usage 与 sweep 同样整个抛、什么都不回也不删", async () => {
		const writer = registerThree();
		const ref = await put(writer, A);
		await age(ref, 10 * DAY);
		store.register({
			name: "坏掉的那家",
			listRefs: async () => {
				throw new Error("读不了盘");
			},
		});

		await expect(store.usage()).rejects.toThrow("读不了盘");
		await expect(store.sweep({ now: NOW })).rejects.toThrow("读不了盘");
		expect(await stat(join(dir, ref))).toBeDefined();
	});

	it("成本:对 N 张图只 stat N 次,每家 listRefs 只调一次", async () => {
		const writer = registerThree();
		const refs = [await put(writer, A), await put(writer, B), await put(writer, C)];
		lists.history = refs;
		statCalls.count = 0;

		await store.usage();

		expect(statCalls.count).toBe(refs.length);
		expect(calls).toEqual({
			[IMAGE_REFERRERS.history]: 1,
			[IMAGE_REFERRERS.chat]: 1,
			[IMAGE_REFERRERS.profiles]: 1,
		});
	});
});

describe("sweep 的 removedBytes", () => {
	it("等于被删文件大小之和;宽限期内与有人引用的不算", async () => {
		const writer = registerThree();
		const a = await put(writer, A);
		const b = await put(writer, B);
		const c = await put(writer, C);
		await put(writer, D);
		for (const ref of [a, b, c]) await age(ref, 10 * DAY);
		lists.history = [c];
		// a、b 过期无人引用 → 删;c 被引用;d 在宽限期里。

		const report = await store.sweep({ now: NOW });

		expect([...report.removed].sort()).toEqual([a, b].sort());
		expect(report.removedBytes).toBe(A.byteLength + B.byteLength);
		expect(report).toMatchObject({ referenced: 1, inGrace: 1 });
	});

	it("什么都没删时是 0", async () => {
		const writer = registerThree();
		await put(writer, A);
		expect(await store.sweep({ now: new Date(Date.now() + IMAGE_GRACE_MS - DAY) })).toEqual({
			removed: [],
			removedBytes: 0,
			referenced: 0,
			inGrace: 1,
		});
	});
});

describe("引用方名字接线", () => {
	it("真装配里登记的正是常量表里的全部名字(写错一个或漏登记都红)", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "bn-referrer-names-"));
		const runtime = createAppRuntime(
			BootstrapConfigSchema.parse({ dataDir, logLevel: "silent" }),
			{
				dataRoot: dataDir,
			},
			{ integrationSettings: [settingsSegment] },
		);
		try {
			for (const name of Object.values(IMAGE_REFERRERS)) {
				expect(() => runtime.imageStore.register({ name, listRefs: async () => [] })).toThrow(name);
			}
			// 反面:没登记过的名字不抛,证明上面的抛是「重名」而不是别的。
			expect(() =>
				runtime.imageStore.register({ name: "从没登记过", listRefs: async () => [] }),
			).not.toThrow();
		} finally {
			await runtime.dispose();
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
