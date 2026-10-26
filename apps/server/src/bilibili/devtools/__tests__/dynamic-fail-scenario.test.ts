import { ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { overridableApi } from "../../../devtools/api-overrides.js";
import type { Api } from "../../api/index.js";
import { failureFromBili } from "../../error-codes.js";
import { dynamicScenarios } from "../dynamic.js";
import type { SubPick } from "../live.js";
import { biliRegistry } from "./support/registry.js";

/**
 * 让拉动态返回指定错误码(状态类场景):盖的是传给 DynamicPoller 的 `api.fetchAllDynamic()` 那一个请求,
 * 「下一轮」(可选之后 N 轮)返回请求层会给的失败结果(标准码 + `upstreamCode`),用完自己摘;收摊随时能摘。
 * 它不经请求客户端的拦截,所以回 `-101` 也**不会**把登录状态变成失效 —— 说明文字要如实写明。
 */

const SUBS: SubPick[] = [{ id: "s1", externalId: "100", name: "甲", enabled: true }];

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
}

/** 一次拉动态的结果里的 B 站码:成功是 0,失败是 `upstreamCode`。 */
function codeOf(result: Awaited<ReturnType<FakeApi["fetchAllDynamic"]>>) {
	return result.ok ? 0 : result.upstreamCode;
}

function setup() {
	const raw = new FakeApi();
	const api = overridableApi(raw);
	const detectNow = vi.fn(async () => {
		await api.api.fetchAllDynamic();
	});
	const reg = biliRegistry(
		dynamicScenarios({
			subs: () => SUBS,
			api: () => api,
			dynamic: () => ({ detectNow }),
			profileAvatars: () => undefined,
		}),
	);
	return { reg, api: api.api, raw, detectNow };
}

const ID = "bilibili.dynamic.fail";

describe("bilibili.dynamic.fail", () => {
	it("声明:状态组;错误码默认 -352,轮数默认 1;说明里写明不经请求客户端、不会让登录状态失效", () => {
		const { reg } = setup();
		const decl = reg.list().find((s) => s.id === ID);
		expect(decl).toMatchObject({ id: ID, group: "state" });
		expect(decl?.params.map((p) => p.key)).toEqual(["code", "rounds"]);
		expect(decl?.params.find((p) => p.key === "code")).toMatchObject({
			kind: "number",
			default: -352,
		});
		expect(decl?.params.find((p) => p.key === "rounds")).toMatchObject({
			kind: "number",
			default: 1,
			min: 1,
		});
		expect(decl?.desc).toContain("-101");
		expect(decl?.desc).toContain("不会");
		expect(decl?.desc).toContain("登录状态");
		expect(decl?.desc).toContain("先按「登录失效」再按「重新确认登录」");
	});

	it("跑一下:下一次拉动态回指定的错误码,再下一次回真的", async () => {
		const { reg, api, raw } = setup();
		await reg.run(ID, { code: -509 });

		const failed = await api.fetchAllDynamic();
		expect(failed).toMatchObject({
			ok: false,
			code: "rate_limited",
			upstreamCode: -509,
			message: expect.stringContaining("-509"),
		});
		expect(raw.real).not.toHaveBeenCalled();

		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
		expect(raw.real).toHaveBeenCalledTimes(1);
	});

	it("默认值:不给参数就是 -352、一轮", async () => {
		const { reg, api } = setup();
		await reg.run(ID, {});
		expect(codeOf(await api.fetchAllDynamic())).toBe(-352);
		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
	});

	it("rounds=3:连着三次都回错误码,第四次回真的", async () => {
		const { reg, api } = setup();
		await reg.run(ID, { code: -352, rounds: 3 });
		const codes: Array<number | string | undefined> = [];
		for (let n = 0; n < 4; n++) codes.push(codeOf(await api.fetchAllDynamic()));
		expect(codes).toEqual([-352, -352, -352, 0]);
	});

	it("生效条:显示错误码与还剩几轮;用完就没有了", async () => {
		const { reg, api } = setup();
		expect(reg.active()).toEqual([]);
		await reg.run(ID, { code: -352, rounds: 2 });
		expect(reg.active()).toEqual([{ scenarioId: ID, label: expect.stringContaining("-352") }]);
		expect(reg.active()[0]?.label).toContain("2");
		await api.fetchAllDynamic();
		expect(reg.active()[0]?.label).toContain("1");
		await api.fetchAllDynamic();
		expect(reg.active()).toEqual([]);
	});

	it("用完之后盖板整个摘掉:真接口自己回的错误码原样透传,不被换成空 feed", async () => {
		const { reg, api, raw } = setup();
		await reg.run(ID, {});
		await api.fetchAllDynamic();
		raw.real.mockResolvedValueOnce(failureFromBili(-509, "真的错"));
		expect(await api.fetchAllDynamic()).toMatchObject({
			ok: false,
			upstreamCode: -509,
			message: "真的错",
		});
	});

	it("收摊:没用完也能摘,摘了就回真的", async () => {
		const { reg, api } = setup();
		await reg.run(ID, { rounds: 5 });
		await reg.reset(ID);
		expect(reg.active()).toEqual([]);
		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
	});

	it("再跑一次:换成新的错误码与轮数(不叠加)", async () => {
		const { reg, api } = setup();
		await reg.run(ID, { code: -352, rounds: 5 });
		await reg.run(ID, { code: -509, rounds: 1 });
		expect(codeOf(await api.fetchAllDynamic())).toBe(-509);
		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
	});

	it.each([0, 1.5])("错误码 %s 不是一个错误码 → 拒", async (code) => {
		const { reg, api } = setup();
		await expect(reg.run(ID, { code })).resolves.toMatchObject({ ok: false, code: "invalid" });
		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
	});

	// 轮数不是正整数的话「还剩几轮」永远减不到头,盖板摘不掉。
	it.each([0, -1, 1.5, "abc"])("轮数 %s 不是一个轮数 → 拒", async (rounds) => {
		const { reg, api } = setup();
		await expect(reg.run(ID, { code: -352, rounds })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
	});

	it("与「发动态」共用同一个 fetchAllDynamic 盖板,谁也不把谁摘掉", async () => {
		const { reg, api, detectNow } = setup();
		await reg.run(ID, { code: -352, rounds: 2 });
		// 发动态那一轮撞上错误码(假动态没并进去,引擎只看到错误),跑完它撤自己的盖板,错误码还剩一轮
		await reg.run("bilibili.dynamic.post", {});
		expect(detectNow).toHaveBeenCalledOnce();
		expect(reg.active()[0]?.label).toContain("1");
		expect(codeOf(await api.fetchAllDynamic())).toBe(-352);
		// 用完之后「发动态」照常并假动态
		expect(codeOf(await api.fetchAllDynamic())).toBe(0);
		await reg.run("bilibili.dynamic.post", {});
		expect(reg.active()).toEqual([]);
	});
});
