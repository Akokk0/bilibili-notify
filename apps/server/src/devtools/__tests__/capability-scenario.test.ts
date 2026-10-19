import type {
	Connection,
	ConnectionCapabilities,
	PlatformAdapter,
} from "@bilibili-notify/internal";
import { fail } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createCapabilityInjector } from "../capability-injection.js";
import { createDevRegistry, DevParamError } from "../registry.js";
import { capabilityScenario } from "../scenarios/capability.js";

/**
 * B3:连接能力三态(小程序卡 支持 / 不支持 / 未知)。面板从 `/api/connections/capabilities`
 * 读,那条路最终问的是 `PlatformAdapter.capabilities(adapter)`;探一次走 `probeCapabilities`。
 * 注入 = 两个方法对那个 adapter id 都回假的;没有能力概念的平台(webhook)不碰 —— 面板上
 * 「这个平台不支持」靠的是方法不在。
 */

const OB = {
	id: "ad-ob",
	name: "NapCat",
	adapterKey: "onebot",
	platform: "onebot",
	settings: {},
	enabled: true,
} as unknown as Connection;
const WH = {
	id: "ad-wh",
	name: "钩子",
	adapterKey: "webhook",
	platform: "webhook",
	settings: {},
	enabled: true,
} as unknown as Connection;
const REAL: ConnectionCapabilities = {
	atAll: { state: "supported", checkedAt: 1 },
	inbound: { state: "supported", checkedAt: 1 },
	nativeShare: { state: "unsupported", reason: "1404", checkedAt: 1 },
};

function onebot(): PlatformAdapter {
	return {
		adapterKey: "onebot",
		settingsSchema: z.unknown(),
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		probe: async () => ({ ok: true, latencyMs: 1 }),
		capabilities: () => REAL,
		probeCapabilities: async () => REAL,
		listConnectionCandidates: async () => [],
		start() {},
		stop() {},
	};
}

function webhook(): PlatformAdapter {
	return {
		adapterKey: "webhook",
		settingsSchema: z.unknown(),
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		probe: async () => fail("unsupported", "no probe"),
		listConnectionCandidates: async () => [],
		start() {},
		stop() {},
	};
}

function setup() {
	const injector = createCapabilityInjector();
	const obDialect = onebot();
	const whDialect = webhook();
	const dialects = [obDialect, whDialect];
	const ob = injector.wrap(obDialect);
	const wh = injector.wrap(whDialect);
	const reg = createDevRegistry([
		capabilityScenario({ injector, connections: () => [OB, WH], dialects: () => dialects }),
	]);
	return { reg, ob, wh };
}

describe("connection.capability", () => {
	// 验红:把 `wrap` 换回 `{ ...inner }` 展开,这条红(原型上的方法没带过去)。
	it("包 class 适配器(方法在原型上、读实例状态),没注入的连接原样问到实例", async () => {
		class Classy {
			readonly adapterKey = "onebot";
			readonly settingsSchema = z.unknown();
			private readonly caps = REAL;
			isAvailable() {
				return true;
			}
			async send() {
				return { ok: true as const, latencyMs: 1 };
			}
			async probe() {
				return { ok: true as const, latencyMs: 1 };
			}
			capabilities() {
				return this.caps;
			}
			async probeCapabilities() {
				return this.caps;
			}
			start() {}
			stop() {}
		}
		const injector = createCapabilityInjector();
		const wrapped = injector.wrap(new Classy() as unknown as PlatformAdapter);
		expect(wrapped.capabilities?.(OB)).toBe(REAL);
		expect(await wrapped.probeCapabilities?.(OB)).toBe(REAL);
		expect(await wrapped.probe(OB)).toEqual({ ok: true, latencyMs: 1 });
		injector.set("ad-ob", { ...REAL, nativeShare: { state: "supported", checkedAt: 2 } });
		expect(wrapped.capabilities?.(OB)?.nativeShare.state).toBe("supported");
		expect(wrapped.capabilities?.({ ...OB, id: "other" } as Connection)).toBe(REAL);
	});

	it("没注入:原样透传;webhook 照样没有 capabilities 方法", async () => {
		const { ob, wh } = setup();
		expect(ob.capabilities?.(OB)).toBe(REAL);
		expect(await ob.probeCapabilities?.(OB)).toBe(REAL);
		expect(wh.capabilities).toBeUndefined();
	});

	it("注入 supported:capabilities 与 probeCapabilities 对那个 id 都回假的,别的 id 不受影响", async () => {
		const { reg, ob } = setup();
		const res = await reg.run("connection.capability", { connection: "ad-ob", state: "supported" });
		expect(ob.capabilities?.(OB)).toMatchObject({ nativeShare: { state: "supported" } });
		expect(await ob.probeCapabilities?.(OB)).toMatchObject({ nativeShare: { state: "supported" } });
		expect(ob.capabilities?.({ ...OB, id: "other" } as Connection)).toBe(REAL);
		expect(res.active).toEqual([
			{ scenarioId: "connection.capability", label: "能力 → NapCat 支持小程序卡" },
		]);
	});

	it("注入只换小程序卡这一格:atAll / inbound 沿用方言原本的回答", async () => {
		const { reg, ob } = setup();
		for (const state of ["supported", "unsupported", "unknown"]) {
			await reg.run("connection.capability", { connection: "ad-ob", state });
			const caps = ob.capabilities?.(OB);
			expect(caps?.atAll).toBe(REAL.atAll);
			expect(caps?.inbound).toBe(REAL.inbound);
		}
	});

	it("unsupported 带理由,unknown 可以不带", async () => {
		const { reg, ob } = setup();
		await reg.run("connection.capability", {
			connection: "ad-ob",
			state: "unsupported",
			reason: "假装 1404",
		});
		expect(ob.capabilities?.(OB)).toMatchObject({
			nativeShare: { state: "unsupported", reason: "假装 1404" },
		});
		await reg.run("connection.capability", { connection: "ad-ob", state: "unknown" });
		expect(ob.capabilities?.(OB)?.nativeShare.state).toBe("unknown");
	});

	it("connection 省略取第一个有能力概念的;指到 webhook 就拒", async () => {
		const { reg, ob } = setup();
		await reg.run("connection.capability", { state: "supported" });
		expect(ob.capabilities?.(OB)?.nativeShare.state).toBe("supported");
		await expect(reg.run("connection.capability", { connection: "ad-wh" })).rejects.toBeInstanceOf(
			DevParamError,
		);
	});

	it("有能力概念的平台是问方言问出来的,不是写死的一份名单", async () => {
		// 哪天给官机接上能力探测,devtools 就该跟着能选它 —— 而不是继续说「官机没有能力
		// 这回事」。这里造一份实现了能力方法的官机方言,场景必须认它。
		const injector = createCapabilityInjector();
		const qq: PlatformAdapter = { ...onebot(), adapterKey: "qq-official" };
		const conn = {
			...OB,
			id: "ad-qq",
			name: "官机",
			adapterKey: "qq-official",
			platform: "qq-official",
		} as Connection;
		const reg = createDevRegistry([
			capabilityScenario({ injector, connections: () => [conn], dialects: () => [qq] }),
		]);
		const wrapped = injector.wrap(qq);
		await reg.run("connection.capability", { state: "supported" });
		expect(wrapped.capabilities?.(conn)?.nativeShare.state).toBe("supported");
	});

	it("收摊回真", async () => {
		const { reg, ob } = setup();
		await reg.run("connection.capability", { connection: "ad-ob", state: "supported" });
		expect(await reg.reset("connection.capability")).toEqual([]);
		expect(ob.capabilities?.(OB)).toBe(REAL);
	});

	it("probeCapabilities 的假结果不打真探测(不出网)", async () => {
		const injector = createCapabilityInjector();
		const probe = vi.fn(async () => REAL);
		const wrapped = injector.wrap({ ...onebot(), probeCapabilities: probe });
		injector.set("ad-ob", { ...REAL, nativeShare: { state: "unknown" } });
		await wrapped.probeCapabilities?.(OB);
		expect(probe).not.toHaveBeenCalled();
	});
	it("包装器没碰的可选成员原样带过去 —— 开着 devtools 也不会让那个平台看起来「不支持」某件事", async () => {
		// 带哪些成员由 push/adapter-members.ts 的成员表定;接口多一个成员那张表编译不过,不会悄悄丢。
		const injector = createCapabilityInjector();
		const listConnectionCandidates = vi.fn(async () => []);
		const wrapped = injector.wrap({ ...onebot(), listConnectionCandidates });
		await wrapped.listConnectionCandidates?.(new AbortController().signal);
		expect(listConnectionCandidates).toHaveBeenCalledTimes(1);
	});
});
