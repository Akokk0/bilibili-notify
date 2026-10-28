import { fail, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { overridableApi } from "../../../devtools/api-overrides.js";
import type { Api } from "../../api/index.js";
import { dynamicScenarios } from "../dynamic.js";
import { biliRegistry, rosterEntry } from "./support/registry.js";

/**
 * A3:四类动态 —— 往传给 DynamicPoller 的 `api.fetchAllDynamic()` 结果里**并进**一条假动态
 * (真 feed 照拉,假的排在最前),然后立刻让动态轮询跑一轮检测。守的是形状:渲染器按 `type`
 * 分发,缺 `module_stat` / `vip` / `major.archive.badge` 这类字段就是一次渲染期 undefined。
 *
 * 挑人只看 B 站自己的名单:300 的作品开关关着(造了也被轮询跳过),100 / 200 开着。名字不在名单里,
 * 经 B 站自己的接口现拉用户卡(100 拉得到「甲」,200 拉不到)。
 */

const ROSTER = [rosterEntry("300", ["liveStart"]), rosterEntry("100"), rosterEntry("200")];

class FakeApi {
	real = vi.fn(
		async (): ReturnType<Api["fetchAllDynamic"]> =>
			ok({
				data: {
					has_more: false,
					items: [{ id_str: "real-1" }] as never,
					offset: "",
					update_baseline: "",
					update_num: 0,
				},
			}),
	);
	fetchAllDynamic() {
		return this.real();
	}
	cards = vi.fn(
		async (uid: string): ReturnType<Api["fetchUserCard"]> =>
			uid === "100"
				? ok({ data: { card: { name: "甲" } } as never })
				: fail("rate_limited", "风控了"),
	);
	fetchUserCard(uid: string) {
		return this.cards(uid);
	}
}

type Feed = Awaited<ReturnType<FakeApi["fetchAllDynamic"]>>;

/** 拉动态成功时的动态列表;失败就让用例当场红。 */
function itemsOf(result: Feed) {
	if (!result.ok) throw new Error(`拉动态失败:${result.message}`);
	return result.data.items;
}

/** 动态轮询那一轮看到的 feed:假动态只在那一轮里存在,跑完就撤,所以得在 detectNow 里抓。 */
interface SetupOptions {
	profileAvatars?: () => { avatarUrlOf(uid: string): string | undefined } | undefined;
}

function setup(options: SetupOptions = {}) {
	const raw = new FakeApi();
	const api = overridableApi(raw);
	let seen: Feed | undefined;
	const detectNow = vi.fn(async () => {
		seen = await api.api.fetchAllDynamic();
	});
	const reg = biliRegistry(
		dynamicScenarios({
			roster: () => ROSTER,
			api: () => api,
			dynamic: () => ({ detectNow }),
			profileAvatars: options.profileAvatars ?? (() => undefined),
		}),
		ROSTER,
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

describe("bilibili.dynamic.post", () => {
	it("声明:事件组、快捷位、type 四选", () => {
		const { reg } = setup();
		const [decl] = reg.list();
		expect(decl).toMatchObject({ id: "bilibili.dynamic.post", group: "event", quick: true });
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
		const res = await reg.run("bilibili.dynamic.post", {
			creator: "100",
			type: "word",
			text: "今天也要元气满满",
		});

		expect(detectNow).toHaveBeenCalledOnce();
		expect(res).toMatchObject({ ok: true, summary: expect.stringContaining("甲") });

		const feed = seen();
		expect(itemsOf(feed).map((i) => i.id_str)).toEqual([expect.stringMatching(/^dev-/), "real-1"]);
		const fake = itemsOf(feed)[0] as Record<string, unknown>;
		expect(fake).toMatchObject({
			type: "DYNAMIC_TYPE_WORD",
			modules: {
				module_author: {
					mid: 100,
					name: "甲",
					face: "https://i0.hdslb.com/bfs/face/member/noface.jpg",
					pub_ts: Math.floor(Date.parse("2026-09-06T08:00:00.000Z") / 1000),
					vip: { type: 0 },
				},
				module_stat: { comment: { count: 0 }, forward: { count: 0 }, like: { count: 0 } },
				module_dynamic: { desc: { text: "今天也要元气满满" } },
			},
		});
	});

	it("假动态作者头像取自 B 站状态里记的网址;没有就退默认头像", async () => {
		const fromState = setup({
			profileAvatars: () => ({
				avatarUrlOf: (uid) => (uid === "200" ? "https://i0.hdslb.com/state/200.jpg" : undefined),
			}),
		});
		await fromState.reg.run("bilibili.dynamic.post", { creator: "200", type: "word" });
		const withState = itemsOf(fromState.seen())[0] as {
			modules: { module_author: { face: unknown } };
		};
		expect(withState.modules.module_author.face).toBe("https://i0.hdslb.com/state/200.jpg");

		const withoutState = setup();
		await withoutState.reg.run("bilibili.dynamic.post", { creator: "200", type: "word" });
		const fallback = itemsOf(withoutState.seen())[0] as {
			modules: { module_author: { face: unknown } };
		};
		expect(fallback.modules.module_author.face).toBe(
			"https://i0.hdslb.com/bfs/face/member/noface.jpg",
		);
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
		await reg.run("bilibili.dynamic.post", { type });
		const fake = itemsOf(seen())[0] as unknown as {
			modules: { module_dynamic: unknown };
		};
		expect(fake.modules.module_dynamic).toMatchObject(expected);
	});

	it("forward:带一条 orig,orig 也是完整的一条", async () => {
		const { reg, seen } = setup();
		await reg.run("bilibili.dynamic.post", { type: "forward" });
		const fake = itemsOf(seen())[0] as unknown as {
			type: string;
			orig?: { type: string; modules: unknown };
		};
		expect(fake.type).toBe("DYNAMIC_TYPE_FORWARD");
		expect(fake.orig).toMatchObject({
			type: "DYNAMIC_TYPE_WORD",
			modules: { module_stat: expect.anything(), module_author: expect.anything() },
		});
	});

	it("跑完那一轮之后假动态从 feed 里撤掉 —— 动态轮询已经推进锚点,留着只是脏 feed", async () => {
		const { reg, api } = setup();
		await reg.run("bilibili.dynamic.post", {});
		// run 里 await 了 detectNow;之后再拉 feed 就该只剩真的。
		expect(itemsOf(await api.fetchAllDynamic()).map((i) => i.id_str)).toEqual(["real-1"]);
	});

	it("真 feed 拉不到(没登录)也照样造:用一份空底", async () => {
		const { reg, api, raw, seen } = setup();
		raw.real.mockRejectedValue(new Error("-101"));
		await expect(reg.run("bilibili.dynamic.post", {})).resolves.toBeTruthy();
		expect(itemsOf(seen())).toHaveLength(1);
		// 撤掉之后又回到真的那条路,照样抛。
		await expect(api.fetchAllDynamic()).rejects.toThrow("-101");
	});

	it("作者名经 B 站自己的接口现拉用户卡;拉不到(失败 / 抛)就用 UID", async () => {
		const failed = setup();
		await failed.reg.run("bilibili.dynamic.post", { creator: "200", type: "word" });
		expect(failed.raw.cards).toHaveBeenCalledWith("200");
		const fake = itemsOf(failed.seen())[0] as { modules: { module_author: { name: unknown } } };
		expect(fake.modules.module_author.name).toBe("UID 200");

		const thrown = setup();
		thrown.raw.cards.mockRejectedValue(new Error("连不上"));
		await expect(
			thrown.reg.run("bilibili.dynamic.post", { creator: "100", type: "word" }),
		).resolves.toMatchObject({ ok: true, summary: expect.stringContaining("UID 100") });
	});

	it("creator 省略取名单里第一个开着作品的;作品关着的拒;不在名单里宿主就拒", async () => {
		const { reg, detectNow } = setup();
		await expect(reg.run("bilibili.dynamic.post", {})).resolves.toMatchObject({
			ok: true,
			summary: expect.stringContaining("甲"),
		});
		await expect(reg.run("bilibili.dynamic.post", { creator: "200" })).resolves.toMatchObject({
			ok: true,
			summary: expect.stringContaining("UID 200"),
		});
		await expect(reg.run("bilibili.dynamic.post", { creator: "300" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("作品"),
		});
		await expect(reg.run("bilibili.dynamic.post", { creator: "zzz" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringContaining("不在名单里"),
		});
		expect(detectNow).toHaveBeenCalledTimes(2);
	});

	it("动态轮询还没起来 → 拒,而不是把假动态留在 feed 里等", async () => {
		const api = overridableApi(new FakeApi());
		const reg = biliRegistry(
			dynamicScenarios({
				roster: () => ROSTER,
				api: () => api,
				dynamic: () => undefined,
				profileAvatars: () => undefined,
			}),
			ROSTER,
		);
		await expect(reg.run("bilibili.dynamic.post", {})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(itemsOf(await api.api.fetchAllDynamic()).map((i) => i.id_str)).toEqual(["real-1"]);
	});
});
