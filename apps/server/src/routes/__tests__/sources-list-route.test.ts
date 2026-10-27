/**
 * `GET /api/sources` —— 来源表:每个来源一条 `{ key, descriptor, has? }`(ADR-0027 决策 6)。
 *
 * 跑真 app、真来源登记表;装载器那张表手造。两张表这样合:
 * - 登记表里不是拓展的(B 站)取登记时交的描述符;
 * - 拓展取装载器那份清单(已按当前语言盖好译文),跑没跑都列 —— 停用 / 起不来的不带 `has`(= 不知道);
 *   在跑的也取清单那份、不取登记时冻住的那份,换了语言才不会显示旧名字。
 * `has` 由宿主看来源实现了哪些可选成员推出来;会员体系这一期不上线(档位图标是图库引用,读者在 4-26)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourcesResponse } from "@bilibili-notify/contract";
import { FEATURE_KEYS, type Source } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { createApp, createCardSkinStore } from "../../app.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BILI_SOURCE_DESCRIPTOR } from "../../bilibili/source.js";
import type { BootstrapConfig } from "../../config/schema.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";
import { makeIntegration } from "../../subscriptions/__tests__/fixtures.js";

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

/** 清单里开了订阅那一口的拓展行。 */
function extensionEntry(
	id: string,
	state: ExtensionEntry["state"],
	subscription: Record<string, unknown>,
): ExtensionEntry {
	return {
		id,
		dir: `/data/extensions/${id}`,
		state,
		manifest: {
			id,
			name: `${id} 拓展`,
			description: "测试用",
			version: "1.0.0",
			apiVersion: 3,
			contributes: { subscription },
		} as never,
	};
}

function sourceOf(partial: Partial<Source>): Source {
	return {
		descriptor: { label: "测试", supportedFeatures: ["post"] },
		searchCreators: noCandidates,
		fetchProfile: noProfile,
		start: async () => {},
		stop: async () => {},
		...partial,
	};
}

describe("GET /api/sources", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sources-list-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot(opts: { sources: Record<string, Source>; entries?: ExtensionEntry[] }) {
		const runtime = createAppRuntime(
			makeBootstrap(dataDir),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		for (const [key, source] of Object.entries(opts.sources)) {
			await runtime.sourceRegistry.register(key, source, makeIntegration() as never);
		}
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			// 装载器只用到列表;拓展自己的挂载口给个空的。
			extensions: { loaded: () => opts.entries ?? [], mounts: { route: new Hono() } } as never,
		});
		const res = await app.request("/api/sources");
		const body = (await res.json()) as SourcesResponse;
		await runtime.dispose();
		return { status: res.status, body };
	}

	it("B 站那条带它自己的描述(短名、颜色、搜人收哪几种、特性全列),线上不带会员体系", async () => {
		const { status, body } = await boot({
			sources: { bilibili: sourceOf({ descriptor: BILI_SOURCE_DESCRIPTOR }) },
		});
		expect(status).toBe(200);
		expect(body.sources).toHaveLength(1);
		const [bili] = body.sources;
		expect(bili?.key).toBe("bilibili");
		expect(bili?.descriptor).toMatchObject({
			label: "B 站",
			shortLabel: "B",
			color: "#fb7299",
			creatorNoun: "UP主",
			externalIdNoun: "UID",
			postNoun: "动态",
			searchAccepts: ["id", "link", "name"],
			supportedFeatures: [...FEATURE_KEYS],
		});
		expect(bili?.descriptor).not.toHaveProperty("membershipPrograms");
		expect(bili?.descriptor).not.toHaveProperty("icon");
	});

	it("has 由宿主看来源实现了哪些可选成员推出来", async () => {
		const { body } = await boot({
			sources: {
				full: sourceOf({
					auth: {} as never,
					fetchLiveStatus: async () => ({ ok: true, status: "offline" }) as never,
				}),
				bare: sourceOf({}),
			},
		});
		expect(body.sources.map((one) => [one.key, one.has])).toEqual([
			["full", { auth: true, liveStatus: true }],
			["bare", { auth: false, liveStatus: false }],
		]);
	});

	it("拓展跑没跑都照清单列出:停用、起不来的不带 has;在跑的取清单那份描述,不取登记时那份", async () => {
		const subscription = {
			label: "抖音",
			shortLabel: "抖",
			color: "#fe2c55",
			postNoun: "作品",
			searchAccepts: ["name"],
			supportedFeatures: ["post", "liveStart"],
		};
		const { body } = await boot({
			sources: {
				// 登记时交的那份是旧名字(换语言之前);面板要的是装载器此刻那份。
				douyin: sourceOf({ descriptor: { label: "旧名字", supportedFeatures: ["post"] } }),
			},
			entries: [
				extensionEntry("douyin", "running", subscription),
				extensionEntry("kuaishou", "disabled", { label: "快手", supportedFeatures: ["post"] }),
				extensionEntry("weibo", "failed", { label: "微博", supportedFeatures: ["post"] }),
			],
		});
		expect(body.sources).toEqual([
			{ key: "douyin", descriptor: subscription, has: { auth: false, liveStatus: false } },
			{ key: "kuaishou", descriptor: { label: "快手", supportedFeatures: ["post"] } },
			{ key: "weibo", descriptor: { label: "微博", supportedFeatures: ["post"] } },
		]);
	});

	it("拓展清单写了的格原样下发(图标、搜人收的输入都在),自带皮肤的包内路径不下发", async () => {
		const declared = {
			label: "抖音",
			shortLabel: "抖",
			color: "#fe2c55",
			icon: "data:image/png;base64,iVBORw0KGgo=",
			postNoun: "作品",
			creatorNoun: "博主",
			externalIdNoun: "抖音号",
			externalIdRegex: "[a-z0-9_]+",
			searchAccepts: ["link", "name"],
			supportedFeatures: ["post"],
		};
		const { body } = await boot({
			sources: {},
			entries: [extensionEntry("douyin", "disabled", { ...declared, cardSkin: "card-skin" })],
		});
		expect(body.sources).toEqual([{ key: "douyin", descriptor: declared }]);
	});

	it("没开订阅那一口的拓展、清单读不出来的拓展不列", async () => {
		const pushOnly: ExtensionEntry = {
			...extensionEntry("bridge", "running", {}),
			manifest: {
				id: "bridge",
				name: "桥",
				description: "测试用",
				version: "1.0.0",
				apiVersion: 3,
				contributes: { push: { label: "桥", shortLabel: "桥", color: "#000000" } },
			} as never,
		};
		const unreadable: ExtensionEntry = {
			id: "broken",
			dir: "/data/extensions/broken",
			state: "failed",
			detail: "清单读不出来",
		};
		const { body } = await boot({ sources: {}, entries: [pushOnly, unreadable] });
		expect(body.sources).toEqual([]);
	});
});
