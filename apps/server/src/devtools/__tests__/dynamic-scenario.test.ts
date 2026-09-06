import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { overridableApi } from "../api-overrides.js";
import { createDevRegistry, DevParamError } from "../registry.js";
import { dynamicScenarios } from "../scenarios/dynamic.js";
import type { SubPick } from "../scenarios/live.js";

/**
 * A3:四类动态 —— 往传给 DynamicEngine 的 `api.getAllDynamic()` 结果里**并进**一条假动态
 * (真 feed 照拉,假的排在最前),然后立刻让引擎跑一轮检测。守的是形状:渲染器按 `type`
 * 分发,缺 `module_stat` / `vip` / `major.archive.badge` 这类字段就是一次渲染期 undefined。
 */

const SUBS: SubPick[] = [
	{ id: "s1", uid: "100", name: "甲", enabled: true, avatar: "https://i0.hdslb.com/a.jpg" },
	{ id: "s2", uid: "200", name: "乙", enabled: false },
];

class FakeApi {
	real = vi.fn(async () => ({
		code: 0,
		message: "ok",
		data: {
			has_more: false,
			items: [{ id_str: "real-1" }],
			offset: "",
			update_baseline: "",
			update_num: 0,
		},
	}));
	getAllDynamic() {
		return this.real();
	}
}

type Feed = Awaited<ReturnType<FakeApi["getAllDynamic"]>>;

/** 引擎那一轮看到的 feed:假动态只在那一轮里存在,跑完就撤,所以得在 detectNow 里抓。 */
function setup() {
	const raw = new FakeApi();
	const api = overridableApi(raw);
	let seen: Feed | undefined;
	const detectNow = vi.fn(async () => {
		seen = await api.api.getAllDynamic();
	});
	const reg = createDevRegistry(
		dynamicScenarios({ subs: () => SUBS, api, dynamic: () => ({ detectNow }) }),
	);
	return {
		reg,
		api: api.api,
		raw,
		detectNow,
		seen: () => {
			if (!seen) throw new Error("detectNow 没跑");
			return seen;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-06T08:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("dynamic.post", () => {
	it("声明:事件组、快捷位、type 四选", () => {
		const { reg } = setup();
		const [decl] = reg.list();
		expect(decl).toMatchObject({ id: "dynamic.post", group: "event", quick: true });
		const type = decl?.params.find((p) => p.key === "type");
		expect(type?.kind === "enum" && type.options.map((o) => o.value)).toEqual([
			"word",
			"draw",
			"av",
			"article",
			"forward",
		]);
	});

	it("跑一下:feed 里多出一条假动态排在真的前面、作者是这位 UP、pub_ts 是现在;然后立刻跑一轮检测", async () => {
		const { reg, detectNow, seen } = setup();
		const res = await reg.run("dynamic.post", {
			sub: "s1",
			type: "word",
			text: "今天也要元气满满",
		});

		expect(detectNow).toHaveBeenCalledOnce();
		expect(res.summary).toContain("甲");

		const feed = seen();
		expect(feed.data.items.map((i) => i.id_str)).toEqual([
			expect.stringMatching(/^dev-/),
			"real-1",
		]);
		const fake = feed.data.items[0] as Record<string, unknown>;
		expect(fake).toMatchObject({
			type: "DYNAMIC_TYPE_WORD",
			modules: {
				module_author: {
					mid: 100,
					name: "甲",
					face: "https://i0.hdslb.com/a.jpg",
					pub_ts: Math.floor(Date.parse("2026-09-06T08:00:00.000Z") / 1000),
					vip: { type: 0 },
				},
				module_stat: { comment: { count: 0 }, forward: { count: 0 }, like: { count: 0 } },
				module_dynamic: { desc: { text: "今天也要元气满满" } },
			},
		});
	});

	it.each([
		["draw", { major: { opus: expect.objectContaining({ pics: expect.any(Array) }) } }],
		[
			"av",
			{
				major: {
					archive: expect.objectContaining({
						badge: expect.objectContaining({ text: "投稿视频" }),
						stat: expect.anything(),
						cover: expect.any(String),
					}),
				},
			},
		],
		["article", { major: { opus: expect.objectContaining({ title: expect.any(String) }) } }],
	] as const)("%s:major 带齐渲染器要的字段", async (type, expected) => {
		const { reg, seen } = setup();
		await reg.run("dynamic.post", { type });
		const fake = seen().data.items[0] as unknown as {
			modules: { module_dynamic: unknown };
		};
		expect(fake.modules.module_dynamic).toMatchObject(expected);
	});

	it("forward:带一条 orig,orig 也是完整的一条", async () => {
		const { reg, seen } = setup();
		await reg.run("dynamic.post", { type: "forward" });
		const fake = seen().data.items[0] as unknown as {
			type: string;
			orig?: { type: string; modules: unknown };
		};
		expect(fake.type).toBe("DYNAMIC_TYPE_FORWARD");
		expect(fake.orig).toMatchObject({
			type: "DYNAMIC_TYPE_WORD",
			modules: { module_stat: expect.anything(), module_author: expect.anything() },
		});
	});

	it("跑完那一轮之后假动态从 feed 里撤掉 —— 引擎已经推进锚点,留着只是脏 feed", async () => {
		const { reg, api } = setup();
		await reg.run("dynamic.post", {});
		// run 里 await 了 detectNow;之后再拉 feed 就该只剩真的。
		expect((await api.getAllDynamic()).data.items.map((i) => i.id_str)).toEqual(["real-1"]);
	});

	it("真 feed 拉不到(没登录)也照样造:用一份空底", async () => {
		const { reg, api, raw, seen } = setup();
		raw.real.mockRejectedValue(new Error("-101"));
		await expect(reg.run("dynamic.post", {})).resolves.toBeTruthy();
		expect(seen().data.items).toHaveLength(1);
		// 撤掉之后又回到真的那条路,照样抛。
		await expect(api.getAllDynamic()).rejects.toThrow("-101");
	});

	it("sub 省略取第一个启用的;停用的也能指定;没这个订阅就拒", async () => {
		const { reg } = setup();
		await expect(reg.run("dynamic.post", {})).resolves.toMatchObject({
			summary: expect.stringContaining("甲"),
		});
		await expect(reg.run("dynamic.post", { sub: "s2" })).resolves.toMatchObject({
			summary: expect.stringContaining("乙"),
		});
		await expect(reg.run("dynamic.post", { sub: "zzz" })).rejects.toBeInstanceOf(DevParamError);
	});

	it("引擎还没起来 → 拒,而不是把假动态留在 feed 里等", async () => {
		const api = overridableApi(new FakeApi());
		const reg = createDevRegistry(
			dynamicScenarios({ subs: () => SUBS, api, dynamic: () => undefined }),
		);
		await expect(reg.run("dynamic.post", {})).rejects.toBeInstanceOf(DevParamError);
		expect((await api.api.getAllDynamic()).data.items.map((i) => i.id_str)).toEqual(["real-1"]);
	});
});
