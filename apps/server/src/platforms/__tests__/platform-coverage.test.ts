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

import type { Connection, PlatformAdapter, ServiceContext } from "@bilibili-notify/internal";
import { CONNECTION_PLATFORMS, connectionDispatchKey } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { adapterForConnection } from "../../push/dispatch.js";
import { createOnebotAdapter } from "../onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official.js";
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
		signal: new AbortController().signal,
		track: () => {},
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
	];
}

/** 造一条该平台的直连连接 —— 分发只看 `kind` 与 `platform`。 */
function directConnection(platform: string): Connection {
	return { kind: "direct", platform } as unknown as Connection;
}

/**
 * 矩阵是按**适配器键**索引的。核心装配的这几个恰好覆盖平台词表 —— **拓展注册进来的那些
 * 不在这儿**:它们的键是拓展 id,由宿主填(ADR-0012 决策 28),盘上装了什么决定有几个,
 * 而这条守卫问的是「核心自己有没有漏掉一个平台」。
 */
describe("adapter 矩阵覆盖平台词表", () => {
	it("闭集里每个平台的直连连接,都恰好找得到一个 adapter", () => {
		const matrix = buildMatrix();
		for (const platform of CONNECTION_PLATFORMS) {
			const claimers = matrix.filter(
				(adapter) => adapterForConnection([adapter], directConnection(platform)) !== undefined,
			);
			expect(claimers.length, `平台 ${platform} 的 adapter`).toBe(1);
		}
	});

	it("也没有多出来的 —— 每个 adapter 的键都是某个平台的分发键,键不重复", () => {
		const keys = buildMatrix().map((a) => a.adapterKey);
		const dispatchKeys = CONNECTION_PLATFORMS.map((p) =>
			connectionDispatchKey(directConnection(p)),
		);
		expect([...keys].sort()).toEqual([...new Set(dispatchKeys)].sort());
	});
});
