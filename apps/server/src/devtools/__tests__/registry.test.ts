import { describe, expect, it, vi } from "vite-plus/test";
import {
	createDevRegistry,
	DevParamError,
	type DevScenarioDef,
	DevScenarioNotFound,
} from "../registry.js";

/**
 * devtools 的中央注册表:一张表、两半共用一个形状。这一层管三件事 —— 把声明(纯数据)
 * 交出去、把参数按 schema 补默认值并挡掉不合法的、把各场景「当前生效」的注入汇成一条。
 * 场景**做什么**它不管,那是各 def 的 `run`。
 */

function def(overrides: Partial<DevScenarioDef> = {}): DevScenarioDef {
	return {
		id: "x.one",
		group: "state",
		title: "一号",
		params: [],
		run: vi.fn(async () => ({})),
		...overrides,
	};
}

describe("createDevRegistry", () => {
	it("list() 只交出声明,不带函数", () => {
		const reg = createDevRegistry([
			def({
				id: "a",
				params: [{ key: "n", label: "N", kind: "number", default: 3 }],
				quick: true,
				icon: "live",
			}),
		]);
		expect(reg.list()).toEqual([
			{
				id: "a",
				group: "state",
				title: "一号",
				params: [{ key: "n", label: "N", kind: "number", default: 3 }],
				quick: true,
				icon: "live",
			},
		]);
	});

	it("同 id 注册两次直接拒绝 —— 两半合一份,撞名只会静默盖掉一个", () => {
		expect(() => createDevRegistry([def({ id: "a" }), def({ id: "a" })])).toThrow(/a/);
	});

	it("run() 按 schema 补默认值:enum / number / text 各一档", async () => {
		const run = vi.fn(async () => ({ summary: "done" }));
		const reg = createDevRegistry([
			def({
				id: "a",
				params: [
					{
						key: "phase",
						label: "阶段",
						kind: "enum",
						options: [{ value: "ready", label: "已就绪" }],
						default: "ready",
					},
					{ key: "count", label: "条数", kind: "number", default: 6 },
					{ key: "target", label: "版本", kind: "text", default: "0.99.0" },
				],
				run,
			}),
		]);

		const res = await reg.run("a", {});

		expect(run).toHaveBeenCalledWith({ phase: "ready", count: 6, target: "0.99.0" });
		expect(res.summary).toBe("done");
	});

	it("run() 给的值压过默认值;number 收字符串也转成数", async () => {
		const run = vi.fn(async () => ({}));
		const reg = createDevRegistry([
			def({
				id: "a",
				params: [
					{ key: "count", label: "条数", kind: "number", default: 6, min: 1, max: 10 },
					{ key: "target", label: "版本", kind: "text", default: "0.99.0" },
				],
				run,
			}),
		]);

		await reg.run("a", { count: "8", target: "1.2.3", stray: "x" });

		// 没声明的键丢掉:面板发什么服务端就信什么的话,场景拿到的参数形状就不由 schema 说了算。
		expect(run).toHaveBeenCalledWith({ count: 8, target: "1.2.3" });
	});

	it("enum 不在选项里 / number 越界 → DevParamError", async () => {
		const reg = createDevRegistry([
			def({
				id: "a",
				params: [
					{
						key: "phase",
						label: "阶段",
						kind: "enum",
						options: [{ value: "ready", label: "已就绪" }],
						default: "ready",
					},
					{ key: "count", label: "条数", kind: "number", default: 6, min: 1, max: 10 },
				],
			}),
		]);

		await expect(reg.run("a", { phase: "nope" })).rejects.toBeInstanceOf(DevParamError);
		await expect(reg.run("a", { count: 11 })).rejects.toBeInstanceOf(DevParamError);
		await expect(reg.run("a", { count: "abc" })).rejects.toBeInstanceOf(DevParamError);
	});

	it("sub / target / adapter 不补默认值 —— 省略就省略,交给场景自己在服务端挑", async () => {
		const run = vi.fn(async () => ({}));
		const reg = createDevRegistry([
			def({ id: "a", params: [{ key: "sub", label: "订阅", kind: "sub" }], run }),
		]);

		await reg.run("a", {});
		expect(run).toHaveBeenCalledWith({});

		await reg.run("a", { sub: "uid-1" });
		expect(run).toHaveBeenLastCalledWith({ sub: "uid-1" });
	});

	it("没这个场景 → DevScenarioNotFound", async () => {
		const reg = createDevRegistry([def({ id: "a" })]);
		await expect(reg.run("zzz", {})).rejects.toBeInstanceOf(DevScenarioNotFound);
	});

	it("active() 汇总各场景当前生效的注入;run() 回执里也带一份", async () => {
		let on = false;
		const reg = createDevRegistry([
			def({
				id: "a",
				run: async () => {
					on = true;
					return {};
				},
				active: () => (on ? { scenarioId: "a", label: "假的 A" } : null),
				reset: () => {
					on = false;
				},
			}),
			// 事件类场景没有 active —— 跑完即走。
			def({ id: "b", group: "event" }),
		]);

		expect(reg.active()).toEqual([]);
		const res = await reg.run("a", {});
		expect(res.active).toEqual([{ scenarioId: "a", label: "假的 A" }]);
		expect(reg.active()).toEqual([{ scenarioId: "a", label: "假的 A" }]);
	});

	it("reset(id) 只收那一个;reset() 全收", async () => {
		const state = { a: false, c: false };
		const mk = (id: "a" | "c") =>
			def({
				id,
				run: async () => {
					state[id] = true;
					return {};
				},
				active: () => (state[id] ? { scenarioId: id, label: id } : null),
				reset: () => {
					state[id] = false;
				},
			});
		const reg = createDevRegistry([mk("a"), mk("c")]);
		await reg.run("a", {});
		await reg.run("c", {});

		expect(await reg.reset("a")).toEqual([{ scenarioId: "c", label: "c" }]);
		expect(await reg.reset()).toEqual([]);
		await expect(reg.reset("zzz")).rejects.toBeInstanceOf(DevScenarioNotFound);
	});
	it("list() 回的是同一份声明表:声明是静态的,轮询不该每次都重新剥一遍", () => {
		const reg = createDevRegistry([
			{ id: "a", group: "state", title: "A", params: [], run: () => ({}) },
		]);
		expect(reg.list()).toBe(reg.list());
	});
});
