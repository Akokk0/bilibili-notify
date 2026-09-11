import type {
	Connection,
	ConnectionCapabilities,
	PlatformAdapter,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
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
	kind: "direct",
	platform: "onebot",
	enabled: true,
} as unknown as Connection;
const WH = {
	id: "ad-wh",
	name: "钩子",
	kind: "direct",
	platform: "webhook",
	enabled: true,
} as unknown as Connection;
const REAL: ConnectionCapabilities = {
	miniAppCard: { state: "unsupported", reason: "1404", checkedAt: 1 },
};

function onebot(): PlatformAdapter {
	return {
		platforms: ["onebot"],
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		probe: async () => ({ ok: true, latencyMs: 1 }),
		capabilities: () => REAL,
		probeCapabilities: async () => REAL,
	};
}

function webhook(): PlatformAdapter {
	return {
		platforms: ["webhook"],
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		probe: async () => ({ ok: null, latencyMs: 0 }),
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
	it("没注入:原样透传;webhook 照样没有 capabilities 方法", async () => {
		const { ob, wh } = setup();
		expect(ob.capabilities?.(OB)).toBe(REAL);
		expect(await ob.probeCapabilities?.(OB)).toBe(REAL);
		expect(wh.capabilities).toBeUndefined();
	});

	it("注入 supported:capabilities 与 probeCapabilities 对那个 id 都回假的,别的 id 不受影响", async () => {
		const { reg, ob } = setup();
		const res = await reg.run("connection.capability", { connection: "ad-ob", state: "supported" });
		expect(ob.capabilities?.(OB)).toMatchObject({ miniAppCard: { state: "supported" } });
		expect(await ob.probeCapabilities?.(OB)).toMatchObject({ miniAppCard: { state: "supported" } });
		expect(ob.capabilities?.({ ...OB, id: "other" } as Connection)).toBe(REAL);
		expect(res.active).toEqual([
			{ scenarioId: "connection.capability", label: "能力 → NapCat 支持小程序卡" },
		]);
	});

	it("unsupported 带理由,unknown 可以不带", async () => {
		const { reg, ob } = setup();
		await reg.run("connection.capability", {
			connection: "ad-ob",
			state: "unsupported",
			reason: "假装 1404",
		});
		expect(ob.capabilities?.(OB)).toMatchObject({
			miniAppCard: { state: "unsupported", reason: "假装 1404" },
		});
		await reg.run("connection.capability", { connection: "ad-ob", state: "unknown" });
		expect(ob.capabilities?.(OB)?.miniAppCard.state).toBe("unknown");
	});

	it("connection 省略取第一个有能力概念的;指到 webhook 就拒", async () => {
		const { reg, ob } = setup();
		await reg.run("connection.capability", { state: "supported" });
		expect(ob.capabilities?.(OB)?.miniAppCard.state).toBe("supported");
		await expect(reg.run("connection.capability", { connection: "ad-wh" })).rejects.toBeInstanceOf(
			DevParamError,
		);
	});

	it("有能力概念的平台是问方言问出来的,不是写死的一份名单", async () => {
		// 哪天给官机接上能力探测,devtools 就该跟着能选它 —— 而不是继续说「官机没有能力
		// 这回事」。这里造一份实现了能力方法的官机方言,场景必须认它。
		const injector = createCapabilityInjector();
		const qq: PlatformAdapter = { ...onebot(), platforms: ["qq-official"] };
		const conn = { ...OB, id: "ad-qq", name: "官机", platform: "qq-official" } as Connection;
		const reg = createDevRegistry([
			capabilityScenario({ injector, connections: () => [conn], dialects: () => [qq] }),
		]);
		const wrapped = injector.wrap(qq);
		await reg.run("connection.capability", { state: "supported" });
		expect(wrapped.capabilities?.(conn)?.miniAppCard.state).toBe("supported");
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
		injector.set("ad-ob", { miniAppCard: { state: "unknown" } });
		await wrapped.probeCapabilities?.(OB);
		expect(probe).not.toHaveBeenCalled();
	});
	it("包装器不认识的成员也原样带过去 —— 接口日后多一个方法,这里不用跟、也不会悄悄丢", () => {
		// 旧写法逐个转发,接口每加一个可选方法都得回来补一行;漏了不会有类型错,只会在开着
		// devtools 的时候让那个平台看起来「不支持」某件事。
		const injector = createCapabilityInjector();
		const extra = () => "extra";
		const wrapped = injector.wrap({ ...onebot(), extra } as ReturnType<typeof onebot>);
		expect((wrapped as unknown as { extra: () => string }).extra).toBe(extra);
	});
});
