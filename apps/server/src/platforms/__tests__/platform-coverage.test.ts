/**
 * 注册表里的每个平台都得有人接。
 *
 * `CONNECTION_PLATFORMS` 是闭集,每一档说好了要配齐「一份 config schema + 一个 server
 * adapter + 一排面板控件」。可 adapter 那一格没人核对过 —— 往注册表里加一档、忘了给它
 * 写 adapter,构建全绿、面板照样让主人建这条连接,只有真发的时候才在投递层报一句
 * `no platform adapter`。主人看到的是「配好了但发不出去」,而不是「这平台还没做」。
 *
 * 这条守卫把矩阵与词表钉在一起:多一档少一档都红。**不构造任何 I/O** —— 三个工厂在
 * 构造期只是拼闭包,连的时候才动网络。
 */

import type { ServiceContext } from "@bilibili-notify/internal";
import { BRIDGE_DISPATCH_KEY, CONNECTION_PLATFORMS } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BridgeServer } from "../../bridge/server.js";
import { createBridgeAdapter } from "../bridge.js";
import { createOnebotAdapter } from "../onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official.js";
import type { PlatformAdapter } from "../types.js";
import { createWebhookAdapter } from "../webhook.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
	};
}

/** 与 `index.ts` 装配的是同一份矩阵 —— 那边加一个 adapter,这边也要加。 */
function buildMatrix(): PlatformAdapter[] {
	const logger = makeLogger();
	const serviceCtx = makeServiceCtx();
	return [
		createOnebotAdapter({ logger, serviceCtx }),
		createQQOfficialAdapter({ logger, serviceCtx, registry: createQQSessionRegistry() }),
		createWebhookAdapter({ logger }),
		createBridgeAdapter({
			logger,
			server: {} as unknown as BridgeServer,
			blobs: { put: () => "blob" },
		}),
	];
}

/**
 * 矩阵是按**分发键**索引的,而分发键 = 平台词表 + 桥那一个。桥不在平台词表里(它没有
 * 单一平台),所以这张表的键集合比词表多一个,不是「恰好等于」。
 */
const DISPATCH_KEYS = [...CONNECTION_PLATFORMS, BRIDGE_DISPATCH_KEY];

describe("adapter 矩阵覆盖分发键", () => {
	it("每个分发键都恰好有一个 adapter 认领", () => {
		const claimed = new Map<string, number>();
		for (const adapter of buildMatrix()) {
			for (const platform of adapter.platforms) {
				claimed.set(platform, (claimed.get(platform) ?? 0) + 1);
			}
		}
		for (const key of DISPATCH_KEYS) {
			expect(claimed.get(key) ?? 0, `分发键 ${key} 的 adapter`).toBe(1);
		}
	});

	it("也没有多认领的 —— adapter 声明了一个表外的键就是拼错了", () => {
		const declared = buildMatrix().flatMap((a) => [...a.platforms]);
		expect([...new Set(declared)].sort()).toEqual([...DISPATCH_KEYS].sort());
	});
});
