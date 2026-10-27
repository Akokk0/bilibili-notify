/**
 * adapter 矩阵 —— **活的注册表**(ADR-0012 决策 29)。
 *
 * 从前它是开机拼好的一个数组:拓展是后加载的,而且要能被拨开关加载 / 卸载,一个定死的
 * 数组两件事都干不了。
 *
 * 两条纪律钉在这里:**消费方在分发那一刻现问**(存一份下来就等于回到那个数组),以及
 * **键被占了就抛** —— 一个拓展要是能声明 `"onebot"`,它就把内置的那条连接整个截走了,
 * 而两边都不会报错。
 */

import type { Connection, PlatformAdapter } from "@bilibili-notify/internal";
import { neutralPlatformSnapshot } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeAdapterContext } from "../../__tests__/support/adapter-ctx.js";
import { adapterForConnection } from "../dispatch.js";
import { createPlatformAdapterRegistry, sendableAdapters } from "../registry.js";

function fakeAdapter(adapterKey: string): PlatformAdapter {
	return {
		adapterKey,
		isAvailable: () => true,
		send: async () => ({ ok: true, latencyMs: 1 }),
		start: vi.fn(),
		stop: vi.fn(),
	} as unknown as PlatformAdapter;
}

/** 登记表上登记一个适配器(上下文用假的);等它落定(异步 `start` 也在内)。 */
function reg(registry: ReturnType<typeof createPlatformAdapterRegistry>, adapter: PlatformAdapter) {
	return registry.register(adapter, fakeAdapterContext().ctx);
}

/** 先登记好这几个的登记表。 */
async function registryWith(...adapters: PlatformAdapter[]) {
	const registry = createPlatformAdapterRegistry();
	for (const adapter of adapters) await reg(registry, adapter);
	return registry;
}

function extensionConnection(extensionId: string): Connection {
	return {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "x",
		enabled: true,
		adapterKey: extensionId,
		platform: "telegram",
		settings: {},
		platformSnapshot: neutralPlatformSnapshot("telegram"),
	};
}

describe("adapter 注册表", () => {
	it("开机那几个照旧,注册进来的也在", async () => {
		const builtin = fakeAdapter("onebot");
		const registry = await registryWith(builtin);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot"]);

		const bridge = fakeAdapter("bridge");
		await reg(registry, bridge);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["onebot", "bridge"]);
		expect(sendableAdapters(registry)).toEqual([builtin, bridge]);
	});

	it("**分发那一刻现问** —— 早就拿到注册表的消费者,下一次问就看得见新注册的", async () => {
		const registry = createPlatformAdapterRegistry();
		// 消费方只握着注册表,不握着某一次的结果。
		const route = (connection: Connection) => adapterForConnection(registry.list(), connection);
		expect(route(extensionConnection("bridge"))).toBeUndefined();

		await reg(registry, fakeAdapter("bridge"));
		expect(route(extensionConnection("bridge"))?.adapterKey).toBe("bridge");
	});

	it("撤下之后就找不到了 —— 卸载一个拓展 = 从表里删一行", async () => {
		const registry = createPlatformAdapterRegistry();
		const handle = await reg(registry, fakeAdapter("bridge"));
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();

		handle.dispose();
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeUndefined();
		expect(registry.list()).toEqual([]);
	});

	it("键被占了 → 拒。**不许悄悄顶掉** —— 那等于把别人的连接整个截走", async () => {
		const registry = await registryWith(fakeAdapter("onebot"));
		await expect(reg(registry, fakeAdapter("onebot"))).rejects.toThrow(/onebot/);
	});

	it("撤下之后同一个键可以重来 —— 停用再启用走的就是这条", async () => {
		const registry = createPlatformAdapterRegistry();
		(await reg(registry, fakeAdapter("bridge"))).dispose();
		const second = fakeAdapter("bridge");
		await reg(registry, second);
		expect(sendableAdapters(registry)).toEqual([second]);
		expect(adapterForConnection(registry.list(), extensionConnection("bridge"))).toBeDefined();
	});

	it("webhook 键被占了 → 拒 —— 四个 webhook 平台共用这一个键", async () => {
		const registry = await registryWith(fakeAdapter("webhook"));
		await expect(reg(registry, fakeAdapter("webhook"))).rejects.toThrow(/webhook/);
	});

	it("dispose 是幂等的", async () => {
		const registry = createPlatformAdapterRegistry();
		const handle = await reg(registry, fakeAdapter("bridge"));
		handle.dispose();
		expect(() => handle.dispose()).not.toThrow();
		expect(registry.list()).toEqual([]);
	});
});

/**
 * 出口咽喉:登记表对外只给不含 `send` 的视图,带 `send` 的完整适配器只有 `sendableAdapters` 一个取法
 * (全仓只许派发器引它,那条由源码扫描守卫钉)。
 */
describe("adapter 注册表 · 出口咽喉", () => {
	it("list() 回的元素没有 send —— 类型上没有,运行时也真的没有", async () => {
		const registry = await registryWith(fakeAdapter("onebot"));
		const [view] = registry.list();
		expect(view).toBeDefined();
		expect("send" in (view as object)).toBe(false);
		expect(view?.adapterKey).toBe("onebot");
	});

	it("同一个适配器两次 list() 回同一个视图对象", async () => {
		const registry = await registryWith(fakeAdapter("onebot"));
		expect(registry.list()[0]).toBe(registry.list()[0]);
	});

	it("sendableAdapters 回的是带 send 的原适配器", async () => {
		const onebot = fakeAdapter("onebot");
		const registry = await registryWith(onebot);
		expect(sendableAdapters(registry)).toEqual([onebot]);
		expect(typeof sendableAdapters(registry)[0]?.send).toBe("function");
	});

	it("不是我们造的登记表 → 抛,不静默回空", () => {
		expect(() =>
			sendableAdapters({
				register: async () => ({ dispose() {} }),
				list: () => [],
				onChange: () => ({ dispose() {} }),
			}),
		).toThrow();
	});

	it("同一个出口两次问到的是同一个视图对象(完整适配器同理)", async () => {
		const registry = await registryWith(fakeAdapter("onebot"));
		expect(registry.list()[0]).toBe(registry.list()[0]);
		expect(sendableAdapters(registry)[0]).toBe(sendableAdapters(registry)[0]);
	});
});

/** 登记即启动、注销即停止(ADR-0024 决策 3):启停只归登记表。 */
describe("adapter 注册表 · 登记即 start、注销即 stop", () => {
	it("登记即调 start,拿到的就是传进去的那份 ctx", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		const { ctx } = fakeAdapterContext();
		await registry.register(adapter, ctx);
		expect(adapter.start).toHaveBeenCalledTimes(1);
		expect(adapter.start).toHaveBeenCalledWith(ctx);
	});

	it("start 抛了 → 原样拒,键放掉、表里没有它、同一个键能再登记", async () => {
		const registry = createPlatformAdapterRegistry();
		const broken = fakeAdapter("bridge");
		const boom = new Error("boom");
		vi.mocked(broken.start).mockImplementation(() => {
			throw boom;
		});
		await expect(registry.register(broken, fakeAdapterContext().ctx)).rejects.toThrow(boom);
		expect(registry.list()).toEqual([]);
		expect(sendableAdapters(registry)).toEqual([]);

		const again = fakeAdapter("bridge");
		await reg(registry, again);
		expect(again.start).toHaveBeenCalledTimes(1);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["bridge"]);
	});

	it("start 回一个 reject 的 Promise → 登记失败:原样拒,键放掉、表里没有它、同一个键能再登记", async () => {
		const registry = createPlatformAdapterRegistry();
		const seen = vi.fn();
		registry.onChange(seen);
		const broken = fakeAdapter("bridge");
		vi.mocked(broken.start).mockImplementation(() => Promise.reject(new Error("async-boom")));
		await expect(registry.register(broken, fakeAdapterContext().ctx)).rejects.toThrow("async-boom");
		expect(registry.list()).toEqual([]);
		expect(sendableAdapters(registry)).toEqual([]);
		// 登记失败不发「成功」那一声。
		expect(seen).not.toHaveBeenCalled();

		const again = fakeAdapter("bridge");
		await reg(registry, again);
		expect(again.start).toHaveBeenCalledTimes(1);
		expect(registry.list().map((a) => a.adapterKey)).toEqual(["bridge"]);
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it("把手 dispose 调一次 stop,再调不重复", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		const handle = await reg(registry, adapter);
		expect(adapter.stop).not.toHaveBeenCalled();
		handle.dispose();
		handle.dispose();
		expect(adapter.stop).toHaveBeenCalledTimes(1);
	});

	it("stop 同步抛了 → 不往外抛,用 ctx.logger.warn 记一行", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		vi.mocked(adapter.stop).mockImplementation(() => {
			throw new Error("sync-fail");
		});
		const warn = vi.fn();
		const { ctx } = fakeAdapterContext([], { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });
		const handle = await registry.register(adapter, ctx);
		expect(() => handle.dispose()).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("sync-fail");
		// 抛了也已经摘掉、放了键。
		expect(registry.list()).toEqual([]);
	});

	it("stop 回一个失败的 Promise → 不往外抛、不等它,失败落下来时记一行 warn", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		vi.mocked(adapter.stop).mockImplementation(() => Promise.reject(new Error("async-fail")));
		const warn = vi.fn();
		const { ctx } = fakeAdapterContext([], { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });
		const handle = await registry.register(adapter, ctx);
		expect(() => handle.dispose()).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("async-fail");
	});

	it("stop 回一个非原生 thenable(reject)→ 同样不往外抛,失败落下来时记一行 warn", async () => {
		const registry = createPlatformAdapterRegistry();
		const adapter = fakeAdapter("bridge");
		vi.mocked(adapter.stop).mockImplementation(
			() =>
				({
					// biome-ignore lint/suspicious/noThenProperty: 故意造一个非原生的 thenable
					then(_resolve: (v: unknown) => void, reject: (e: unknown) => void) {
						reject(new Error("thenable-fail"));
					},
				}) as unknown as Promise<void>,
		);
		const warn = vi.fn();
		const { ctx } = fakeAdapterContext([], { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() });
		const handle = await registry.register(adapter, ctx);
		expect(() => handle.dispose()).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("thenable-fail");
	});

	it("视图上没有 send / start / stop —— 启停只归登记表,运行时也真的没有", async () => {
		const registry = await registryWith(fakeAdapter("onebot"));
		const [view] = registry.list();
		for (const name of ["send", "start", "stop"]) expect(name in (view as object)).toBe(false);
	});
});

/** 拿 class 写的适配器:方法在原型上、读实例状态 —— 第三方拓展最常见的写法。 */
class ClassAdapter {
	readonly adapterKey = "classy";
	readonly settingsSchema = {} as never;
	private readonly latencyMs = 42;
	private checks = 0;
	start() {}
	stop() {}
	async probe() {
		return { ok: true as const, latencyMs: this.latencyMs };
	}
	isAvailable() {
		this.checks += 1;
		return this.checks > 0;
	}
	async send() {
		return { ok: true as const, latencyMs: this.latencyMs };
	}
	capabilities() {
		return {
			atAll: { state: "supported" as const, checkedAt: "2026-10-26T00:00:00.000Z" },
			inbound: { state: "unknown" as const },
			nativeShare: { state: "unknown" as const },
		};
	}
}

describe("adapter 注册表 · class 写的适配器(方法在原型上)", () => {
	// 验红:把 `viewOf` 换回对象展开,这条红(原型上的方法没被带过去,视图上 probe 是 undefined)。
	it("登记后经视图调 probe / capabilities、经完整适配器调 send,都读得到实例状态", async () => {
		const registry = await registryWith(new ClassAdapter() as unknown as PlatformAdapter);
		const [view] = registry.list();
		expect(await view?.probe(extensionConnection("classy"))).toEqual({ ok: true, latencyMs: 42 });
		expect(view?.capabilities?.(extensionConnection("classy"))?.atAll).toEqual({
			state: "supported",
			checkedAt: "2026-10-26T00:00:00.000Z",
		});
		expect(view?.isAvailable(extensionConnection("classy"), {} as never)).toBe(true);
		const [full] = sendableAdapters(registry);
		expect(await full?.send(extensionConnection("classy"), {} as never, {} as never)).toEqual({
			ok: true,
			latencyMs: 42,
		});
	});
});

describe("adapter 注册表 · onChange", () => {
	it("登记与撤下各叫一次;start 抛了(登记失败)不叫;dispose 之后不再叫", async () => {
		const registry = createPlatformAdapterRegistry();
		const seen = vi.fn();
		const sub = registry.onChange(seen);
		const handle = await reg(registry, fakeAdapter("a"));
		expect(seen).toHaveBeenCalledTimes(1);
		handle.dispose();
		expect(seen).toHaveBeenCalledTimes(2);
		handle.dispose();
		expect(seen).toHaveBeenCalledTimes(2);

		const broken = fakeAdapter("b");
		(broken.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("boom");
		});
		await expect(reg(registry, broken)).rejects.toThrow("boom");
		expect(seen).toHaveBeenCalledTimes(2);

		sub.dispose();
		await reg(registry, fakeAdapter("c"));
		expect(seen).toHaveBeenCalledTimes(2);
	});
});
