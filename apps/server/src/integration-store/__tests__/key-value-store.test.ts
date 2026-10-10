/**
 * 一袋键值的规矩:拷贝、先落盘再生效、保留前缀、限额、值是不是 JSON、`batch` 的「先验后写再换」。
 * 落盘换成「记一笔」的内存版,规矩的实现与生产是同一份(`createKeyValueStores`)。
 */

import type { Json, KeyValueOp } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { memoryKeyValueStores } from "../../__tests__/support/memory-key-value-store.js";
import { SECRETS_LIMITS, STATE_LIMITS, serializeEntries } from "../key-value-store.js";

function invalid(result: { ok: boolean; code?: string }) {
	expect(result).toMatchObject({ ok: false, code: "invalid" });
}

describe("读写与拷贝", () => {
	it("get 交回的是一份拷贝:改它不影响存着的", async () => {
		const { store } = memoryKeyValueStores();
		await store.set("k", { list: [1, 2], inner: { a: 1 } });
		const first = store.get<{ list: number[]; inner: { a: number } }>("k");
		first?.list.push(3);
		if (first) first.inner.a = 99;
		expect(store.get("k")).toEqual({ list: [1, 2], inner: { a: 1 } });
	});

	it("set 之后再改手里的原值,也不影响存着的", async () => {
		const { store } = memoryKeyValueStores();
		const value = { list: [1] };
		await store.set("k", value);
		value.list.push(2);
		expect(store.get("k")).toEqual({ list: [1] });
	});

	it("`await` 回来之前 get 还是旧值,回来之后是新值(落了盘才生效)", async () => {
		const { store, persists } = memoryKeyValueStores();
		await store.set("k", "old");
		const pending = store.set("k", "new");
		expect(store.get("k")).toBe("old");
		await pending;
		expect(store.get("k")).toBe("new");
		expect(persists).toHaveLength(2);
	});

	it("delete 之后读不到;删一个本来没有的键不写盘", async () => {
		const { store, persists } = memoryKeyValueStores();
		await store.set("k", 1);
		await store.delete("k");
		expect(store.get("k")).toBeUndefined();
		const before = persists.length;
		expect(await store.delete("never")).toEqual({ ok: true });
		expect(persists).toHaveLength(before);
	});

	it("存一个没变的值不写盘", async () => {
		const { store, persists } = memoryKeyValueStores();
		await store.set("k", { a: [1] });
		await store.set("k", { a: [1] });
		expect(persists).toHaveLength(1);
	});

	it("键是第三方给的:`__proto__` 当普通数据存,不碰原型", async () => {
		const { store } = memoryKeyValueStores();
		expect(await store.set("__proto__", { polluted: true })).toEqual({ ok: true });
		expect(store.get("__proto__")).toEqual({ polluted: true });
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});
});

describe("保留前缀:`http.` 开头的键归宿主", () => {
	it("集成那一面写 `http.` 键 → invalid,盘上不动", async () => {
		const { store, persists } = memoryKeyValueStores("secrets");
		invalid(await store.set("http.cookies", "x"));
		invalid(await store.delete("http.cookies"));
		invalid(await store.batch([{ kind: "set", key: "http.identity", value: 1 }]));
		expect(persists).toHaveLength(0);
	});

	it("宿主那一面只许 `http.` 键,别的 → invalid;同一袋,写进去的看得见", async () => {
		const { stores, store, persists } = memoryKeyValueStores("secrets");
		const host = stores.host;
		invalid(await host.set("refreshToken", "x"));
		expect(await host.set("http.cookies", "[]")).toEqual({ ok: true });
		expect(host.get("http.cookies")).toBe("[]");
		expect(stores.snapshot().get("http.cookies")).toBe("[]");
		// 集成那一面写自己的键,宿主那一面的键原样留着。
		await store.set("refreshToken", "t");
		expect(stores.snapshot().get("http.cookies")).toBe("[]");
		expect(persists.at(-1)?.get("refreshToken")).toBe("t");
	});

	it("宿主写的 `http.` 键计入整份限额:超了同样 invalid", async () => {
		const { stores } = memoryKeyValueStores("secrets");
		const host = stores.host;
		invalid(await host.set("http.cookies", "a".repeat(SECRETS_LIMITS.maxTotalBytes)));
		expect(await host.set("http.cookies", "a".repeat(1000))).toEqual({ ok: true });
	});

	it("宿主写的键占着额度,集成这一面能用的就少了", async () => {
		const { stores, store } = memoryKeyValueStores("secrets");
		await stores.host.set("http.cookies", "a".repeat(200 * 1024));
		invalid(await store.set("big", "b".repeat(100 * 1024)));
		expect(await store.set("small", "b".repeat(1024))).toEqual({ ok: true });
	});
});

describe("限额(对应用完之后的整袋算,差一个字节的两边)", () => {
	/** 往 `initial` 里再放一个键 `z`,让整份恰好等于 `limit`(`pad` 个字符)与多一个字节。 */
	function padFor(initial: Record<string, Json>, limit: number): number {
		const base = new Map(Object.entries({ ...initial, z: "" }));
		return limit - Buffer.byteLength(serializeEntries(base));
	}

	it("state 单键 64KB:恰好 OK,多一个字节 invalid", async () => {
		const { store } = memoryKeyValueStores("state");
		// 值序列化后 = 两个引号 + 内容
		const fit = "a".repeat(STATE_LIMITS.maxKeyBytes - 2);
		expect(await store.set("k", fit)).toEqual({ ok: true });
		invalid(await store.set("k2", `${fit}a`));
		expect(store.get("k2")).toBeUndefined();
	});

	it("state 整份 1MB:恰好 OK,多一个字节 invalid", async () => {
		const initial: Record<string, Json> = {};
		for (let i = 0; i < 16; i++) initial[`k${i}`] = "a".repeat(64_000);
		const pad = padFor(initial, STATE_LIMITS.maxTotalBytes);
		expect(pad).toBeGreaterThan(0);
		expect(pad).toBeLessThan(STATE_LIMITS.maxKeyBytes - 2);
		const over = memoryKeyValueStores("state", initial);
		invalid(await over.store.set("z", "a".repeat(pad + 1)));
		const fit = memoryKeyValueStores("state", initial);
		expect(await fit.store.set("z", "a".repeat(pad))).toEqual({ ok: true });
	});

	it("secrets 整份 256KB:恰好 OK,多一个字节 invalid;不设单键上限", async () => {
		const initial: Record<string, Json> = { big: "a".repeat(100 * 1024) };
		const pad = padFor(initial, SECRETS_LIMITS.maxTotalBytes);
		const over = memoryKeyValueStores("secrets", initial);
		invalid(await over.store.set("z", "a".repeat(pad + 1)));
		const fit = memoryKeyValueStores("secrets", initial);
		expect(await fit.store.set("z", "a".repeat(pad))).toEqual({ ok: true });
		// 单个值超过 64KB 在 secrets 里照收(只受整份限制)。
		expect(await memoryKeyValueStores("secrets").store.set("one", "a".repeat(200 * 1024))).toEqual({
			ok: true,
		});
	});

	it("限额算的是应用完之后的整袋:先超后删的一批,净值没超就过", async () => {
		const { store } = memoryKeyValueStores("secrets");
		const big = "a".repeat(SECRETS_LIMITS.maxTotalBytes);
		expect(
			await store.batch([
				{ kind: "set", key: "tmp", value: big },
				{ kind: "delete", key: "tmp" },
				{ kind: "set", key: "keep", value: 1 },
			]),
		).toEqual({ ok: true });
		expect(store.get("keep")).toBe(1);
	});

	it("键:空、超过 256 字节都 invalid", async () => {
		const { store } = memoryKeyValueStores();
		invalid(await store.set("", 1));
		invalid(await store.set("k".repeat(257), 1));
		expect(await store.set("k".repeat(256), 1)).toEqual({ ok: true });
	});
});

describe("值不是 JSON", () => {
	const bad: Array<[string, unknown]> = [
		["undefined", undefined],
		["函数", () => 1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["Date", new Date()],
		["Map", new Map()],
		["类实例", new (class Foo {})()],
		["symbol", Symbol("s")],
		["bigint", 10n],
		["嵌套里的 undefined", { a: [1, undefined] }],
		["嵌套里的函数", { a: { b: () => 1 } }],
	];
	for (const [label, value] of bad) {
		it(`${label} → invalid,盘上不动`, async () => {
			const { store, persists } = memoryKeyValueStores();
			invalid(await store.set("k", value as Json));
			expect(store.get("k")).toBeUndefined();
			expect(persists).toHaveLength(0);
		});
	}

	it("循环引用 / 嵌套太深 → invalid(不爆栈)", async () => {
		const { store } = memoryKeyValueStores();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		invalid(await store.set("k", cyclic as Json));
	});

	it("合规的值各种形状都收", async () => {
		const { store } = memoryKeyValueStores();
		const value: Json = { s: "x", n: 1.5, b: false, z: null, l: [1, "a", { deep: [true] }] };
		expect(await store.set("k", value)).toEqual({ ok: true });
		expect(store.get("k")).toEqual(value);
	});
});

describe("batch:保证一起成或一起不成", () => {
	it("一步不合规矩,整批 invalid,一步都不做", async () => {
		const { store, persists } = memoryKeyValueStores();
		await store.set("existing", 1);
		const before = persists.length;
		invalid(
			await store.batch([
				{ kind: "set", key: "a", value: 1 },
				{ kind: "delete", key: "existing" },
				{ kind: "set", key: "bad", value: Number.NaN },
			]),
		);
		expect(store.get("a")).toBeUndefined();
		expect(store.get("existing")).toBe(1);
		expect(persists).toHaveLength(before);
	});

	it("未知的 kind 也整批 invalid", async () => {
		const { store, persists } = memoryKeyValueStores();
		invalid(
			await store.batch([
				{ kind: "set", key: "a", value: 1 },
				{ kind: "upsert", key: "b", value: 2 } as unknown as KeyValueOp,
			]),
		);
		expect(persists).toHaveLength(0);
	});

	it("同一个键出现几次,后面的盖前面的", async () => {
		const { store } = memoryKeyValueStores();
		await store.batch([
			{ kind: "set", key: "k", value: 1 },
			{ kind: "set", key: "k", value: 2 },
			{ kind: "set", key: "gone", value: 1 },
			{ kind: "delete", key: "gone" },
			{ kind: "set", key: "back", value: 1 },
			{ kind: "delete", key: "back" },
			{ kind: "set", key: "back", value: 3 },
		]);
		expect(store.get("k")).toBe(2);
		expect(store.get("gone")).toBeUndefined();
		expect(store.get("back")).toBe(3);
	});

	it("空批直接回成功,不写盘", async () => {
		const { store, persists } = memoryKeyValueStores();
		expect(await store.batch([])).toEqual({ ok: true });
		expect(persists).toHaveLength(0);
	});

	it("落盘只一次,而且第一次落盘那一刻几个键同时是新值", async () => {
		const { store, persists } = memoryKeyValueStores();
		await store.set("old", 0);
		persists.length = 0;
		expect(
			await store.batch([
				{ kind: "set", key: "a", value: "A" },
				{ kind: "set", key: "b", value: "B" },
				{ kind: "delete", key: "old" },
			]),
		).toEqual({ ok: true });
		expect(persists).toHaveLength(1);
		expect(Object.fromEntries(persists[0] ?? [])).toEqual({ a: "A", b: "B" });
	});

	it("写失败整批不生效:内存不变,之后还能写", async () => {
		const { store, persists, failNext } = memoryKeyValueStores();
		await store.set("keep", 1);
		failNext();
		const result = await store.batch([
			{ kind: "set", key: "a", value: 1 },
			{ kind: "delete", key: "keep" },
		]);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		expect(store.get("a")).toBeUndefined();
		expect(store.get("keep")).toBe(1);
		const before = persists.length;
		expect(await store.set("a", 1)).toEqual({ ok: true });
		expect(persists).toHaveLength(before + 1);
	});

	it("内容没变的一批不写盘", async () => {
		const { store, persists } = memoryKeyValueStores();
		await store.batch([
			{ kind: "set", key: "a", value: 1 },
			{ kind: "set", key: "b", value: 2 },
		]);
		const before = persists.length;
		expect(
			await store.batch([
				{ kind: "set", key: "a", value: 1 },
				{ kind: "delete", key: "never" },
			]),
		).toEqual({ ok: true });
		expect(persists).toHaveLength(before);
	});

	it("前一笔还停在落盘半路,后一笔已经来了:后一笔排在它后面,先后不乱", async () => {
		const { store, persists, holdNext } = memoryKeyValueStores();
		const release = holdNext();
		const first = store.set("n", 1);
		const second = store.batch([
			{ kind: "set", key: "n", value: 2 },
			{ kind: "set", key: "m", value: "after" },
		]);
		await new Promise((resolve) => setTimeout(resolve, 10));
		// 第一笔还没落完,第二笔不许抢在前面。
		expect(persists).toHaveLength(0);
		release();
		expect((await Promise.all([first, second])).every((r) => r.ok)).toBe(true);
		expect(persists.map((p) => p.get("n"))).toEqual([1, 2]);
		expect(store.get("n")).toBe(2);
		expect(store.get("m")).toBe("after");
	});

	it("并发的几次写按交进来的顺序一个接一个做(后一次看得见前一次)", async () => {
		const { store, persists } = memoryKeyValueStores();
		const results = await Promise.all([
			store.set("n", 1),
			store.set("n", 2),
			store.batch([{ kind: "set", key: "n", value: 3 }]),
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(store.get("n")).toBe(3);
		expect(persists.map((p) => p.get("n"))).toEqual([1, 2, 3]);
	});
});

describe("replace:整袋换(恢复备份)", () => {
	it("落盘成功才换内存;备份里没有的键,换完也没有;`http.` 键照收", async () => {
		const { stores, store, persists } = memoryKeyValueStores("secrets", {
			old: 1,
			"http.cookies": "x",
		});
		const result = await stores.replace(
			new Map<string, Json>([
				["new", 2],
				["http.cookies", "y"],
			]),
		);
		expect(result).toEqual({ ok: true });
		expect(store.get("old")).toBeUndefined();
		expect(store.get("new")).toBe(2);
		expect(stores.snapshot().get("http.cookies")).toBe("y");
		expect(persists).toHaveLength(1);
	});

	it("换不进去(超限额 / 落盘失败)→ 内存不变", async () => {
		const { stores, store, failNext } = memoryKeyValueStores("secrets", { old: 1 });
		invalid(await stores.replace(new Map<string, Json>([["big", "a".repeat(300 * 1024)]])));
		failNext();
		expect(await stores.replace(new Map<string, Json>([["x", 1]]))).toMatchObject({
			ok: false,
			code: "unavailable",
		});
		expect(store.get("old")).toBe(1);
		expect(store.get("x")).toBeUndefined();
	});
});
