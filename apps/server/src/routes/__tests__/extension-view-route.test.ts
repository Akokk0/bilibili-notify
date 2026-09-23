/**
 * `GET /api/ext/:id/status` 交给面板的 v2 视图(ADR-0019 决策 39 / 40)—— 从拓展 `ctx.publishView`
 * 一路到 HTTP 响应:宿主核过的那一份,坏块换成宿主的提示、好块照原样,都是 200。
 *
 * 核法本身在 `extensions/__tests__/view-check.test.ts`;这里钉的是**接线**:路由吐出去的就是 ctx 核过
 * 的那一份(不是拓展交的原样),而且交回 Promise 的那种也是一条看得见的提示,不是 404、不是空对象。
 */

import type { ExtensionPanelView } from "@bilibili-notify/contract";
import type { ExtensionView } from "@bilibili-notify/extension";
import type {
	ExtensionManifest,
	GlobalConfig,
	Logger,
	ServiceContext,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { ConfigStore } from "../../config/store.js";
import { createExtensionContext } from "../../extensions/context.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { createExtensionUpgrades } from "../../extensions/upgrade.js";
import { createAdapterRegistry } from "../../platforms/registry.js";
import { createExtensionsRoute } from "../extensions.js";

const MANIFEST = {
	id: "douyin",
	name: "抖音",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 2,
	settings: {
		fields: [
			{
				key: "accounts",
				type: "list",
				label: "账号",
				title: "name",
				fields: [{ key: "name", type: "string", label: "名字", required: true }],
			},
		],
	},
	contributes: { push: { display: { label: "抖音", shortLabel: "抖", color: "#111111" } } },
} as unknown as ExtensionManifest;

const SILENT: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** 一个真 ctx(v2,一格列表设置里存着一项)+ 只读它状态那一口的路由。 */
function boot() {
	const runtime = createExtensionContext({
		id: "douyin",
		manifest: MANIFEST,
		host: {
			logger: SILENT,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose() {},
		} as unknown as ServiceContext,
		mounts: createExtensionMounts(),
		adapters: createAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		subscriptions: () => [],
		onSubscriptionsChanged: () => ({ dispose() {} }),
		settings: () => ({ accounts: [{ id: "a1", name: "主号" }] }),
		onSettingsChanged: () => ({ dispose() {} }),
		inbound: {},
		upgrades: createExtensionUpgrades(),
	});
	const app = createExtensionsRoute({
		store: {
			getGlobals: () => ({ extensions: {} }) as unknown as GlobalConfig,
			getConnections: () => [],
		} as unknown as ConfigStore,
		extensions: () => [],
		status: (id) => (id === "douyin" ? runtime.status() : undefined),
		pushSource: () => undefined,
		bots: () => undefined,
	});
	return { ctx: runtime.ctx, app };
}

async function statusOf(app: ReturnType<typeof boot>["app"]) {
	const res = await app.request("/douyin/status");
	return { status: res.status, body: (await res.json()) as ExtensionPanelView };
}

describe("GET /api/ext/:id/status —— v2 视图", () => {
	it("坏块换成宿主的提示、好块照原样、坏项那张卡有自己的提示 —— 一样是 200", async () => {
		const { ctx, app } = boot();
		const notice = { type: "notice", tone: "info", text: "登录有效" } as const;
		ctx.publishView(
			() =>
				({
					summary: { text: "12 位作者在看" },
					page: [{ type: "keyValue", items: [] }, notice],
					items: { accounts: { a1: { status: { tone: "danger", text: "坏了" } } } },
				}) as unknown as ExtensionView,
		);
		const { status, body } = await statusOf(app);
		expect(status).toBe(200);
		expect(body.summary).toEqual({ text: "12 位作者在看" });
		expect(body.page?.[0]).toMatchObject({ fault: { where: "页上第 1 块(键值)" } });
		expect(body.page?.[1]).toEqual({ block: notice });
		expect(body.items?.accounts?.a1).toMatchObject({ fault: { where: "这一项" } });
	});

	it("回调交回 Promise —— 200,一条说清要同步交回的提示,不是 404 也不是空对象", async () => {
		const { ctx, app } = boot();
		ctx.publishView((async () => ({})) as unknown as () => ExtensionView);
		const { status, body } = await statusOf(app);
		expect(status).toBe(200);
		expect(body.page).toEqual([
			{
				fault: {
					where: "整份视图",
					reason: expect.stringContaining("publishView 的回调要同步交回视图"),
				},
			},
		]);
	});

	it("没交过视图 —— 404", async () => {
		const { app } = boot();
		expect((await app.request("/douyin/status")).status).toBe(404);
	});
});
