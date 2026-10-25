import { ok } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createDevtoolsProviderRegistry } from "../providers.js";
import { createDevRegistry, type DevScenarioDef } from "../registry.js";

/**
 * 登记表 `devtoolsProviders`:各家集成交一包场景,核心汇总时给每个场景的 id 与「当前生效」条上的
 * `scenarioId` 统一加 `<来源 id>.` 前缀 —— 两家交同名场景不撞、也冒充不了别家(ADR-0031 决策 2)。
 */

function def(id: string, over: Partial<DevScenarioDef> = {}): DevScenarioDef {
	return { id, group: "event", title: id, params: [], run: () => ok(), ...over };
}

describe("devtoolsProviders", () => {
	it("汇总时场景 id 加上来源前缀,别的字段原样", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("bilibili", { scenarios: [def("live.start", { title: "开播", quick: true })] });

		const [scenario] = providers.scenarios();
		expect(scenario).toMatchObject({ id: "bilibili.live.start", title: "开播", quick: true });
	});

	it("两家交了同名场景不撞:前缀不同,汇进注册表也不抛", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("bilibili", { scenarios: [def("poll-now")] });
		providers.claim("demo", { scenarios: [def("poll-now")] });

		const ids = createDevRegistry(providers.scenarios())
			.list()
			.map((s) => s.id);
		expect(ids).toEqual(["bilibili.poll-now", "demo.poll-now"]);
	});

	it("同一家交了重复 id → 认领时就抛,点名带前缀的 id", () => {
		const providers = createDevtoolsProviderRegistry();
		expect(() => providers.claim("bilibili", { scenarios: [def("a"), def("a")] })).toThrow(
			/bilibili\.a/,
		);
		expect(providers.scenarios()).toEqual([]);
	});

	it("认领的完整 id 撞核心场景时抛,并且不占来源 id", () => {
		const providers = createDevtoolsProviderRegistry(["update.state"]);

		expect(() => providers.claim("update", { scenarios: [def("state")] })).toThrow(/update\.state/);
		expect(providers.scenarios()).toEqual([]);
		expect(() => providers.claim("update", { scenarios: [def("other")] })).not.toThrow();
	});

	it("同一个来源 id 不能被两家认领;撤下之后可以重来", () => {
		const providers = createDevtoolsProviderRegistry();
		const first = providers.claim("bilibili", { scenarios: [def("a")] });
		expect(() => providers.claim("bilibili", { scenarios: [def("b")] })).toThrow(/bilibili/);

		first.dispose();
		expect(providers.scenarios()).toEqual([]);
		providers.claim("bilibili", { scenarios: [def("b")] });
		expect(providers.scenarios().map((s) => s.id)).toEqual(["bilibili.b"]);
	});

	it("「当前生效」条上的 scenarioId 跟着加前缀,收摊按它找得到", async () => {
		const providers = createDevtoolsProviderRegistry();
		let on = false;
		providers.claim("bilibili", {
			scenarios: [
				def("auth.login-state", {
					run: () => {
						on = true;
						return ok();
					},
					active: () => (on ? { scenarioId: "auth.login-state", label: "假登录" } : null),
					reset: () => {
						on = false;
					},
				}),
			],
		});
		const registry = createDevRegistry(providers.scenarios());

		const res = await registry.run("bilibili.auth.login-state", {});
		expect(res).toMatchObject({
			ok: true,
			active: [{ scenarioId: "bilibili.auth.login-state", label: "假登录" }],
		});
		expect(await registry.reset("bilibili.auth.login-state")).toMatchObject({
			ok: true,
			active: [],
		});
	});

	it("没有 active 的场景汇总后仍没有 active", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("demo", { scenarios: [def("a")] });
		expect(providers.scenarios()[0]?.active).toBeUndefined();
	});
});
