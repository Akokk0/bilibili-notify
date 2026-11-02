import type {
	Connection,
	ConnectionCapabilities,
	PlatformAdapter,
} from "@bilibili-notify/internal";
import { fail } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import { placeholderDescriptor } from "../../__tests__/support/adapter-descriptor.js";
import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
import type { ConfigStore } from "../../config/store.js";
import { createTargetDispatcher } from "../../push/target-dispatcher.js";
import { createCapabilityInjector } from "../capability-injection.js";
import { capabilityScenario } from "../scenarios/capability.js";
import { coreDevRegistry } from "./support/core-registry.js";

/**
 * B3:连接能力三态(小程序卡 支持 / 不支持 / 未知)。面板从 `/api/connections/capabilities`
 * 读,那条路最终问的是派发器;探一次走 `probeConnectionCapabilities`。
 *
 * 注入现在接在派发器的能力记忆**之上**(`injectedCapabilities`):注入期间读到假值、假值不进记忆,
 * 收摊即回真;`probeConnectionCapabilities` 也直接交假值、不叫适配器。没有能力概念的平台(webhook)
 * 的场景照旧选不了 —— 面板上「这个平台不支持」靠的是方法不在。
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
	atAll: { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" },
	inbound: { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" },
	nativeShare: { state: "unsupported", reason: "1404", checkedAt: "2026-10-26T00:00:00.000Z" },
};

function onebot(): PlatformAdapter {
	return {
		adapterKey: "onebot",
		settingsSchema: z.unknown(),
		descriptor: placeholderDescriptor(),
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
		descriptor: placeholderDescriptor(),
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
	const dialects = [onebot(), webhook()];
	const reg = coreDevRegistry([
		capabilityScenario({
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			injector,
			connections: () => [OB, WH],
			dialects: () => dialects,
		}),
	]);
	return { reg, injector };
}

/** 真派发器 + devtools 的注入读口(生产不传的那一格):读口盖在能力记忆之上。 */
function dispatcherWith(
	injector: ReturnType<typeof createCapabilityInjector>,
	dialect: PlatformAdapter,
	connection: Connection,
) {
	return createTargetDispatcher({
		store: {
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			getConnection: (id: string) => (id === connection.id ? connection : undefined),
			getTargets: () => [],
		} as unknown as ConfigStore,
		adapters: registryOf([dialect]),
		injectedCapabilities: injector.get,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
}

describe("core.connection.capability", () => {
	it("注入 supported:注入读口对那个连接回假的,别的连接不受影响", async () => {
		const { reg, injector } = setup();
		const res = await reg.run("core.connection.capability", {
			connection: "ad-ob",
			state: "supported",
		});
		expect(injector.get("ad-ob")).toMatchObject({ nativeShare: { state: "supported" } });
		expect(injector.get("other")).toBeUndefined();
		expect(res).toMatchObject({
			ok: true,
			active: [{ scenarioId: "core.connection.capability", label: "能力 → NapCat 支持小程序卡" }],
		});
	});

	it("注入只换小程序卡这一格:atAll / inbound 沿用方言原本的回答", async () => {
		const { reg, injector } = setup();
		for (const state of ["supported", "unsupported", "unknown"]) {
			await reg.run("core.connection.capability", { connection: "ad-ob", state });
			const caps = injector.get("ad-ob");
			expect(caps?.atAll).toBe(REAL.atAll);
			expect(caps?.inbound).toBe(REAL.inbound);
		}
	});

	it("unsupported 带理由,unknown 可以不带", async () => {
		const { reg, injector } = setup();
		await reg.run("core.connection.capability", {
			connection: "ad-ob",
			state: "unsupported",
			reason: "假装 1404",
		});
		expect(injector.get("ad-ob")).toMatchObject({
			nativeShare: { state: "unsupported", reason: "假装 1404" },
		});
		await reg.run("core.connection.capability", { connection: "ad-ob", state: "unknown" });
		expect(injector.get("ad-ob")?.nativeShare.state).toBe("unknown");
	});

	it("connection 省略取第一个有能力概念的;指到 webhook 就拒", async () => {
		const { reg, injector } = setup();
		await reg.run("core.connection.capability", { state: "supported" });
		expect(injector.get(OB.id)?.nativeShare.state).toBe("supported");
		await expect(
			reg.run("core.connection.capability", { connection: "ad-wh" }),
		).resolves.toMatchObject({
			ok: false,
			code: "invalid",
		});
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
		const reg = coreDevRegistry([
			capabilityScenario({
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				injector,
				connections: () => [conn],
				dialects: () => [qq],
			}),
		]);
		await reg.run("core.connection.capability", { state: "supported" });
		expect(injector.get(conn.id)?.nativeShare.state).toBe("supported");
	});

	// 验红:注入包在适配器外面时,假值会被派发器的能力记忆收下,收摊后真适配器回 unknown 也盖不回去。
	it("注入 supported 后收摊,派发器回到真答案(unknown),假值不进记忆", async () => {
		const injector = createCapabilityInjector();
		const dialect: PlatformAdapter = {
			...onebot(),
			capabilities: () => ({ ...REAL, nativeShare: { state: "unknown" } }),
		};
		const dispatcher = dispatcherWith(injector, dialect, OB);
		const reg = coreDevRegistry([
			capabilityScenario({
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				injector,
				connections: () => [OB],
				dialects: () => [dialect],
			}),
		]);

		await reg.run("core.connection.capability", { connection: OB.id, state: "supported" });
		expect(dispatcher.connectionCapabilities(OB.id)?.nativeShare.state).toBe("supported");

		expect(await reg.reset("core.connection.capability")).toMatchObject({ ok: true, active: [] });
		expect(dispatcher.connectionCapabilities(OB.id)?.nativeShare.state).toBe("unknown");
	});

	// 验红:真答案 unsupported 先被记忆收下,注入 unknown 也盖不住它 —— 面板看不到「未探测」。
	it("真答案 unsupported 的连接上注入 unknown,派发器看得到 unknown", async () => {
		const injector = createCapabilityInjector();
		const dialect = onebot(); // 真答案:nativeShare unsupported
		const dispatcher = dispatcherWith(injector, dialect, OB);
		const reg = coreDevRegistry([
			capabilityScenario({
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				injector,
				connections: () => [OB],
				dialects: () => [dialect],
			}),
		]);

		expect(dispatcher.connectionCapabilities(OB.id)?.nativeShare.state).toBe("unsupported");

		await reg.run("core.connection.capability", { connection: OB.id, state: "unknown" });
		expect(dispatcher.connectionCapabilities(OB.id)?.nativeShare.state).toBe("unknown");
	});

	it("probeConnectionCapabilities 的假结果不打真探测(不出网)", async () => {
		const injector = createCapabilityInjector();
		const probe = vi.fn(async () => REAL);
		const dialect: PlatformAdapter = { ...onebot(), probeCapabilities: probe };
		const dispatcher = dispatcherWith(injector, dialect, OB);
		const reg = coreDevRegistry([
			capabilityScenario({
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				injector,
				connections: () => [OB],
				dialects: () => [dialect],
			}),
		]);

		await reg.run("core.connection.capability", { connection: OB.id, state: "supported" });
		expect((await dispatcher.probeConnectionCapabilities(OB.id))?.nativeShare.state).toBe(
			"supported",
		);
		expect(probe).not.toHaveBeenCalled();
	});
});
