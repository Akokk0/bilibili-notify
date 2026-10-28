import { ok } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createDevtoolsProviderRegistry } from "../providers.js";
import { createDevRegistry, type DevScenarioDef } from "../registry.js";

/**
 * 登记表 `devtoolsProviders`:各家集成交一包场景,核心汇总时给每个场景的 id 与「当前生效」条上的
 * `scenarioId` 统一加 `<提供方 id>.` 前缀、把 `provider` 填成提供方 id —— 两家交同名场景不撞、也冒充不了
 * 别家(ADR-0031 决策 2)。核心自己的场景建表时就以 `core` 占着,前缀一样加。
 *
 * 参数种类按提供方收:`sub` / `target` / `connection` 只给核心,别家只收 text / number / enum / creator。
 */

function def(id: string, over: Partial<DevScenarioDef> = {}): DevScenarioDef {
	return { id, group: "event", title: id, params: [], run: () => ok(), ...over };
}

describe("devtoolsProviders", () => {
	it("汇总时场景 id 加上来源前缀、provider 填来源 id,别的字段原样", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("bilibili", { scenarios: [def("live.start", { title: "开播", quick: true })] });

		const [scenario] = providers.scenarios();
		expect(scenario).toMatchObject({
			id: "bilibili.live.start",
			provider: "bilibili",
			title: "开播",
			quick: true,
		});
	});

	it("核心的场景建表时就交:id 加 core.、provider 是 core,排在各家前面", () => {
		const providers = createDevtoolsProviderRegistry([def("update.state")]);
		providers.claim("bilibili", { scenarios: [def("live.start")] });

		expect(providers.scenarios().map((s) => [s.id, s.provider])).toEqual([
			["core.update.state", "core"],
			["bilibili.live.start", "bilibili"],
		]);
	});

	it("场景里自己写的 provider 被盖掉,冒充不了别家", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("demo", { scenarios: [def("a", { provider: "bilibili" })] });
		expect(providers.scenarios()[0]?.provider).toBe("demo");
	});

	it("core 恒被核心占着:别家认领 core 就抛,核心一个场景都没有时也一样", () => {
		const providers = createDevtoolsProviderRegistry();
		expect(() => providers.claim("core", { scenarios: [def("a")] })).toThrow(/core/);
		expect(providers.scenarios()).toEqual([]);
	});

	it("核心的场景自己重名 → 建表就抛", () => {
		expect(() => createDevtoolsProviderRegistry([def("a"), def("a")])).toThrow(/core\.a/);
	});

	it("核心的场景能用 sub / target / connection", () => {
		const providers = createDevtoolsProviderRegistry([
			def("a", {
				params: [
					{ key: "sub", label: "订阅", kind: "sub" },
					{ key: "target", label: "目标", kind: "target" },
					{ key: "connection", label: "连接", kind: "connection" },
				],
			}),
		]);
		expect(providers.scenarios().map((s) => s.id)).toEqual(["core.a"]);
	});

	it("别家用了 sub / target / connection → 认领时抛,点名场景与参数,不占来源 id", () => {
		for (const kind of ["sub", "target", "connection"] as const) {
			const providers = createDevtoolsProviderRegistry();
			expect(() =>
				providers.claim("bilibili", {
					scenarios: [def("a", { params: [{ key: "pick", label: "挑", kind }] })],
				}),
			).toThrow(new RegExp(`bilibili\\.a.*pick.*${kind}`));
			expect(() => providers.claim("bilibili", { scenarios: [def("b")] })).not.toThrow();
		}
	});

	it("别家用了不认识的种类也抛", () => {
		const providers = createDevtoolsProviderRegistry();
		expect(() =>
			providers.claim("demo", {
				scenarios: [def("a", { params: [{ key: "x", label: "X", kind: "color" } as never] })],
			}),
		).toThrow(/demo\.a.*x.*color/);
	});

	it("别家收 text / number / enum / creator", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("bilibili", {
			scenarios: [
				def("a", {
					params: [
						{ key: "t", label: "T", kind: "text" },
						{ key: "n", label: "N", kind: "number", default: 1 },
						{
							key: "e",
							label: "E",
							kind: "enum",
							options: [{ value: "x", label: "X" }],
							default: "x",
						},
						{ key: "creator", label: "UP", kind: "creator" },
					],
				}),
			],
		});
		expect(providers.scenarios().map((s) => s.id)).toEqual(["bilibili.a"]);
	});

	it("认领 / 撤下之间 scenarios() 交回同一份:汇总不在每次读的时候重做", () => {
		const providers = createDevtoolsProviderRegistry([def("a")]);
		const before = providers.scenarios();
		expect(providers.scenarios()).toBe(before);

		const claim = providers.claim("demo", { scenarios: [def("b")] });
		const during = providers.scenarios();
		expect(during).not.toBe(before);
		expect(providers.scenarios()).toBe(during);

		claim.dispose();
		expect(providers.scenarios().map((s) => s.id)).toEqual(["core.a"]);
	});

	it("两家交了同名场景不撞:前缀不同,汇进注册表也不抛", () => {
		const providers = createDevtoolsProviderRegistry([def("poll-now")]);
		providers.claim("bilibili", { scenarios: [def("poll-now")] });
		providers.claim("demo", { scenarios: [def("poll-now")] });

		const ids = createDevRegistry(providers)
			.list()
			.map((s) => s.id);
		expect(ids).toEqual(["core.poll-now", "bilibili.poll-now", "demo.poll-now"]);
	});

	it("同一家交了重复 id → 认领时就抛,点名带前缀的 id", () => {
		const providers = createDevtoolsProviderRegistry();
		expect(() => providers.claim("bilibili", { scenarios: [def("a"), def("a")] })).toThrow(
			/bilibili\.a/,
		);
		expect(providers.scenarios()).toEqual([]);
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
		const registry = createDevRegistry(providers);

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
