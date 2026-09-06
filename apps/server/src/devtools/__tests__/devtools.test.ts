import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import type { UpdateService } from "../../update/service.js";
import { createDevtools } from "../index.js";

/**
 * devtools 那道门 = **载荷版本号是不是开发版**。不是环境变量:环境变量能在生产镜像里被
 * 设上,版本号不能;alpha 也不给 —— 它是发出去给人用的构建。
 */

const REAL: UpdateStatusDTO = {
	currentVersion: "0.0.0-dev",
	rollbackTarget: null,
	pinnedVersion: null,
	state: { phase: "disabled", reason: "dev-build" },
};

const updateService: UpdateService = {
	getStatus: () => REAL,
	check: async () => REAL,
	download: async () => REAL,
	rollback: async () => REAL,
	probeMirrors: async () => [],
};

const BARE = {
	updateService,
	adapters: [],
	historyStore: { deleteRange: async () => 0 },
	api: {} as never,
	subs: () => [],
	dynamic: () => undefined,
	inbound: () => undefined,
	commands: () => ({ prefix: "/" }),
	adapterConfigs: () => [],
	targets: () => [],
	bus: createNodeMessageBus(),
	authSystem: { status: () => ({ status: 5, msg: "" }) } as never,
	puppeteer: () => null,
	live: () => undefined,
	mute: () => undefined,
	fansPoller: () => undefined,
	loginFlow: () => undefined,
	sourceRun: true,
};

describe("createDevtools", () => {
	it.each(["0.0.0-dev", "dev"])("源码上跑的开发版 %s → 给", (payloadVersion) => {
		expect(createDevtools({ ...BARE, payloadVersion })).not.toBeNull();
	});

	it.each(["0.10.0", "0.11.0-alpha.1", "1.0.0-rc.1"])("发出去的版本 %s → 不给", (v) => {
		expect(createDevtools({ ...BARE, payloadVersion: v })).toBeNull();
	});

	/**
	 * 版本号这道门是**失败即敞开**的:`0.0.0-dev` 是仓库里的常驻值(只有发版 workflow 才临时
	 * 同步成真版本号),而版本号读不出来时兜底也正是 `"dev"` —— 于是任何**没走发版流程**的
	 * 构建产物都会自认开发版,把 `/api/dev` 挂出去。`:test` 镜像就是这么来的:它公开推,
	 * 构建前不同步版本。所以还要一道构建产物身上不可能成立的门:跑的是不是 TypeScript 源码。
	 */
	it.each(["0.0.0-dev", "dev"])("版本号是 %s 但跑的是构建产物 → 不给", (payloadVersion) => {
		expect(createDevtools({ ...BARE, payloadVersion, sourceRun: false })).toBeNull();
	});

	it("给的那份:更新服务换成了可注入的装饰器,注册表里有 update.state", async () => {
		const dev = createDevtools({ ...BARE, payloadVersion: "0.0.0-dev" });
		if (dev === null) throw new Error("unreachable");

		expect(dev.registry.list().map((s) => s.id)).toContain("update.state");
		await dev.registry.run("update.state", { phase: "idle" });
		expect(dev.updateService.getStatus().state).toEqual({ phase: "idle" });
		// 真服务没被动过。
		expect(updateService.getStatus().state).toEqual({ phase: "disabled", reason: "dev-build" });
	});
});

describe("createDevtools · 截流接线", () => {
	const ADAPTER = { id: "ad", name: "A", platform: "onebot", enabled: true } as never;
	const TARGET = { id: "t", name: "群", adapterId: "ad", platform: "onebot" } as never;

	function setup() {
		const send = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
		const inner = {
			platforms: ["onebot"] as const,
			isAvailable: () => true,
			send,
			probe: async () => ({ ok: true, latencyMs: 1 }),
		};
		const deleteRange = vi.fn(async () => 2);
		const dev = createDevtools({
			...BARE,
			payloadVersion: "0.0.0-dev",
			adapters: [inner],
			historyStore: { deleteRange } as never,
		});
		if (dev === null) throw new Error("unreachable");
		return { dev, send, deleteRange };
	}

	it("交回去的 adapters 是包过闸的:跑 push.capture 之后不再真发,收摊后又真发", async () => {
		const { dev, send } = setup();
		const [wrapped] = dev.adapters;
		if (!wrapped) throw new Error("unreachable");

		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "1" });
		expect(send).toHaveBeenCalledTimes(1);

		const res = await dev.registry.run("push.capture", {});
		expect(res.active).toEqual([{ scenarioId: "push.capture", label: "推送截流中 · 拦下 0 条" }]);
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "2" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(dev.captures.status()).toMatchObject({ enabled: true, entries: [{ text: "2" }] });
		expect(dev.registry.active()[0]?.label).toBe("推送截流中 · 拦下 1 条");

		dev.registry.reset("push.capture");
		await wrapped.send(ADAPTER, TARGET, { kind: "text", text: "3" });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("清掉截流期间历史行:按每一段窗调 deleteRange,开着的那段截到现在,清完窗从头记", async () => {
		vi.useFakeTimers();
		try {
			const { dev, deleteRange } = setup();
			vi.setSystemTime(new Date("2026-09-06T08:00:00.000Z"));
			await dev.registry.run("push.capture", {});
			vi.setSystemTime(new Date("2026-09-06T08:10:00.000Z"));
			dev.registry.reset("push.capture");
			vi.setSystemTime(new Date("2026-09-06T08:20:00.000Z"));
			await dev.registry.run("push.capture", {});
			vi.setSystemTime(new Date("2026-09-06T08:25:00.000Z"));

			const deleted = await dev.captures.purgeHistory();

			expect(deleted).toBe(4);
			expect(deleteRange.mock.calls).toEqual([
				[
					{
						fromMs: Date.parse("2026-09-06T08:00:00.000Z"),
						toMs: Date.parse("2026-09-06T08:10:00.000Z"),
					},
				],
				[
					{
						fromMs: Date.parse("2026-09-06T08:20:00.000Z"),
						toMs: Date.parse("2026-09-06T08:25:00.000Z"),
					},
				],
			]);
			// 清完:开着的那段从现在起算,再清一次不会把同一段又删一遍。
			deleteRange.mockClear();
			vi.setSystemTime(new Date("2026-09-06T08:30:00.000Z"));
			await dev.captures.purgeHistory();
			expect(deleteRange.mock.calls).toEqual([
				[
					{
						fromMs: Date.parse("2026-09-06T08:25:00.000Z"),
						toMs: Date.parse("2026-09-06T08:30:00.000Z"),
					},
				],
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});
