/**
 * 新建拓展订阅 + 它的头像文件(ADR-0019 决策 9 / 10 / 49 / 50)。
 *
 * 真的 ConfigStore / SubRuntimeStore / 头像仓(`createAppRuntime`,临时 dataDir)、真的 `createApp` ——
 * 装了哪些拓展从 `extensions.loaded` 那一格递进来,与 `index.ts` 同一条线,所以 app 那头漏接的话
 * 这里的每一条新建都会被判成「没装」。删订阅走真的那条路:DELETE → config-changed →
 * `bindSubscriptionStore` → `subscription-changed` 的 remove → 头像跟着删。
 *
 *  - 宿主核 `extensionId`:装着、v2、清单开了订阅源那一口;**没在跑也行**(订阅是数据,决策 10)。
 *  - 同一个拓展名下同一个外部 id 只许一条(决策 50:身份判重)→ 409。
 *  - 候选带来的资料(名字 / 头像 / 粉丝)种进资料缓存;头像存成文件,资料里是同源的相对地址。
 *  - 头像只收位图,魔数要对得上;不合规矩的整次 400、一样都不落。
 *  - B 站那条新建、已有那条整份 POST 回来(启用开关),照旧。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionDTO } from "@bilibili-notify/contract";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { createApp, createCardSkinStore } from "../../app.js";
import type { BootstrapConfig } from "../../config/schema.js";
import { EXTENSION_SUBSCRIPTIONS_FILE } from "../../config/store.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { type AppRuntime, createAppRuntime } from "../../runtime/bootstrap.js";
import { bindSubscriptionStore } from "../../runtime/subscription-store.js";

const SUB_ID = "e1000000-0000-4000-8000-000000000001";
const OTHER_ID = "e1000000-0000-4000-8000-000000000002";

function sourceEntry(id: string, state: ExtensionEntry["state"] = "running"): ExtensionEntry {
	return {
		id,
		dir: `/data/extensions/${id}`,
		state,
		manifest: {
			id,
			name: `${id} 订阅源`,
			description: "一句话说明",
			version: "0.1.0",
			apiVersion: 2,
			contributes: {
				subscription: {
					display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
					events: ["post"],
				},
			},
		},
	};
}

/** v2,只开了推送那一口。 */
const PUSH_ONLY: ExtensionEntry = {
	id: "pusher",
	dir: "/data/extensions/pusher",
	state: "running",
	manifest: {
		id: "pusher",
		name: "只推送",
		description: "一句话说明",
		version: "0.1.0",
		apiVersion: 2,
		contributes: { push: { display: { label: "推", shortLabel: "推", color: "#123456" } } },
	},
};

/** v1 —— 哪怕它的 provides 写着 subscription,v1 的契约里也没有订阅源。 */
const V1: ExtensionEntry = {
	id: "oldie",
	dir: "/data/extensions/oldie",
	state: "running",
	manifest: {
		id: "oldie",
		name: "老拓展",
		description: "一句话说明",
		version: "1.0.0",
		apiVersion: 1,
		provides: ["push", "subscription"],
	},
};

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

let dataDir: string;
let runtime: AppRuntime;
let app: ReturnType<typeof createApp>;
let unbind: () => void;
let entries: ExtensionEntry[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-subs-ext-create-"));
	runtime = createAppRuntime(makeBootstrap(dataDir));
	await runtime.configStore.load();
	await runtime.subRuntimeStore.load();
	// index.ts 同一步:订阅仓镜像配置、改动转成 subscription-changed。
	const binding = bindSubscriptionStore({ bus: runtime.bus, configStore: runtime.configStore });
	unbind = () => binding.dispose();
	entries = [sourceEntry("douyin"), PUSH_ONLY, V1];
	app = createApp(runtime, {
		cardSkins: { store: createCardSkinStore(dataDir) },
		extensions: {
			mounts: createExtensionMounts(),
			loaded: () => entries,
			status: () => undefined,
			pushSource: () => undefined,
			bots: () => undefined,
		},
	});
});

afterEach(async () => {
	unbind();
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

function extSub(overrides: Parameters<typeof makeExtensionSubscription>[0] = {}) {
	return makeExtensionSubscription({
		id: SUB_ID,
		extensionId: "douyin",
		externalId: "sec-1",
		...overrides,
	});
}

function post(body: unknown) {
	return app.request("/api/subs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function listed(): Promise<SubscriptionDTO[]> {
	return (await (await app.request("/api/subs")).json()) as SubscriptionDTO[];
}

async function avatarFiles(): Promise<string[]> {
	try {
		return (await readdir(join(dataDir, "avatars"))).sort();
	} catch {
		return [];
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("新建拓展订阅", () => {
	it("候选的资料种进缓存、头像存成文件;GET 那个地址拿回原样的字节与该有的头", async () => {
		const before = Date.now();
		const res = await post({
			...extSub(),
			cachedProfile: {
				name: "抖音某人",
				avatar: avatarDataUrl("png", PNG_BYTES),
				fans: 42,
				// 客户端给的这两格不收:签名没人报过,刷新时间是服务端的事。
				sign: "客户端编的",
				lastRefreshedAt: "1999-01-01T00:00:00.000Z",
			},
		});
		expect(res.status, await res.clone().text()).toBe(200);

		const row = (await listed()).find((s) => s.id === SUB_ID);
		expect(row).toMatchObject({ kind: "extension", extensionId: "douyin", externalId: "sec-1" });
		const profile = row?.cachedProfile;
		expect(profile).toMatchObject({ name: "抖音某人", sign: "", fans: 42 });
		expect(profile?.avatar).toMatch(new RegExp(`^/api/subs/${SUB_ID}/avatar\\?v=[0-9a-f]{12}$`));
		expect(Date.parse(profile?.lastRefreshedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);

		// 落了盘:拓展订阅那个文件里有它,头像文件在。
		const disk = JSON.parse(
			await readFile(join(dataDir, "state", EXTENSION_SUBSCRIPTIONS_FILE), "utf8"),
		) as Array<{ id: string }>;
		expect(disk.map((s) => s.id)).toEqual([SUB_ID]);
		expect(await avatarFiles()).toEqual([`${SUB_ID}.png`]);

		const img = await app.request(profile?.avatar ?? "");
		expect(img.status).toBe(200);
		expect(Buffer.from(await img.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
		expect(img.headers.get("content-type")).toBe("image/png");
		expect(img.headers.get("x-content-type-options")).toBe("nosniff");
		expect(img.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
	});

	it("不知道粉丝数就不写这一格(写 0 是撒谎);没给头像 → 空串、不建文件", async () => {
		const res = await post({ ...extSub(), cachedProfile: { name: "没头像的人" } });
		expect(res.status, await res.clone().text()).toBe(200);
		const profile = (await listed()).find((s) => s.id === SUB_ID)?.cachedProfile;
		expect(profile).toMatchObject({ name: "没头像的人", avatar: "", sign: "" });
		expect(profile && "fans" in profile).toBe(false);
		expect(await avatarFiles()).toEqual([]);
	});

	it("没带资料 → 只建订阅,不种资料缓存", async () => {
		expect((await post(extSub())).status).toBe(200);
		const row = (await listed()).find((s) => s.id === SUB_ID);
		expect(row).toBeDefined();
		expect(row?.cachedProfile).toBeUndefined();
	});

	it.each([
		["停用", "disabled"],
		["加载失败", "failed"],
	] as const)("拓展装着但%s → 照样建(订阅是数据,不要求它在跑)", async (_label, state) => {
		entries = [sourceEntry("douyin", state)];
		expect((await post(extSub())).status).toBe(200);
		expect((await listed()).map((s) => s.id)).toContain(SUB_ID);
	});

	it.each([
		["没装", "nope", "extension_not_installed"],
		["v1 拓展", "oldie", "not_subscription_source"],
		["只开了推送那一口", "pusher", "not_subscription_source"],
	])("%s → 400,点名为什么,一样都不落", async (_label, extensionId, code) => {
		const res = await post({
			...extSub({ extensionId }),
			cachedProfile: { name: "某人", avatar: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe(code);
		expect(body.message).toContain(extensionId);
		expect(await listed()).toEqual([]);
		expect(await avatarFiles()).toEqual([]);
		expect(runtime.subRuntimeStore.get(SUB_ID)).toBeUndefined();
	});

	it("同一个拓展名下同一个外部 id 已经订阅过 → 409,点名是谁;别的拓展同一个外部 id 不算重", async () => {
		expect((await post(extSub())).status).toBe(200);

		const dup = await post(extSub({ id: OTHER_ID }));
		expect(dup.status).toBe(409);
		const body = (await dup.json()) as { error: string; message: string };
		expect(body.error).toBe("duplicate_subscription");
		expect(body.message).toContain("douyin");
		expect(body.message).toContain("sec-1");
		expect((await listed()).map((s) => s.id)).toEqual([SUB_ID]);

		entries = [sourceEntry("douyin"), sourceEntry("kuaishou")];
		expect((await post(extSub({ id: OTHER_ID, extensionId: "kuaishou" }))).status).toBe(200);
	});

	it.each([
		["SVG", avatarDataUrl("svg+xml", Buffer.from("<svg/>"))],
		["http 地址", "https://p3.douyinpic.com/a.jpeg"],
		["太大", avatarDataUrl("png", Buffer.concat([PNG_BYTES, Buffer.alloc(200 * 1024)]))],
		["声明 png、字节是 jpeg", avatarDataUrl("png", JPEG_BYTES)],
		["声明 jpeg、字节是 webp", avatarDataUrl("jpeg", WEBP_BYTES)],
	])("头像是%s → 400,点名 cachedProfile.avatar,一样都不落", async (_label, avatar) => {
		const res = await post({ ...extSub(), cachedProfile: { name: "某人", avatar } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message: string };
		expect(body.error).toBe("invalid_profile");
		expect(body.message).toContain("cachedProfile.avatar");
		expect(await listed()).toEqual([]);
		expect(await avatarFiles()).toEqual([]);
	});

	it.each([
		["名字是空串", { name: "" }],
		["粉丝数是负的", { name: "某人", fans: -1 }],
		["不是对象", "某人"],
	])("资料里%s → 400", async (_label, cachedProfile) => {
		const res = await post({ ...extSub(), cachedProfile });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_profile");
		expect(await listed()).toEqual([]);
	});

	it("订阅本身形状不对(外部 id 是空串)→ 400 validation_failed,与 store 同一个口径", async () => {
		const res = await post({ ...extSub({ externalId: "" }), cachedProfile: { name: "某人" } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
		expect(await listed()).toEqual([]);
	});

	it("订阅建好之后头像写不进去 → 订阅照建,资料照种、只是没有头像", async () => {
		// 让 `<dataDir>/avatars` 是个文件:建目录那一步必挂。
		await writeFile(join(dataDir, "avatars"), "挡路");
		const warn = vi.spyOn(runtime.serviceCtx.logger, "warn");
		const res = await post({
			...extSub(),
			cachedProfile: { name: "某人", avatar: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status, await res.clone().text()).toBe(200);
		expect((await listed()).find((s) => s.id === SUB_ID)?.cachedProfile).toMatchObject({
			name: "某人",
			avatar: "",
		});
		expect(warn).toHaveBeenCalled();
	});
});

describe("已有的照旧", () => {
	it("已有的拓展订阅整份 POST 回来(启用开关)→ 改得动;带着资料也不重种、不写头像", async () => {
		expect((await post({ ...extSub(), cachedProfile: { name: "原来的名字" } })).status).toBe(200);
		const res = await post({
			...extSub({ enabled: false }),
			cachedProfile: { name: "别的名字", avatar: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status).toBe(200);
		const row = (await listed()).find((s) => s.id === SUB_ID);
		expect(row?.enabled).toBe(false);
		expect(row?.cachedProfile?.name).toBe("原来的名字");
		expect(await avatarFiles()).toEqual([]);
	});

	it("B 站订阅新建照旧,不碰头像目录", async () => {
		const bili = makeEmptySubscription({ id: OTHER_ID, uid: "12345" });
		expect((await post(bili)).status).toBe(200);
		expect((await listed()).map((s) => s.id)).toEqual([OTHER_ID]);
		expect(await exists(join(dataDir, "avatars"))).toBe(false);
	});
});

describe("GET /api/subs/:id/avatar", () => {
	it("没有头像 → 404;id 不是 uuid → 400", async () => {
		expect((await app.request(`/api/subs/${SUB_ID}/avatar`)).status).toBe(404);
		expect((await app.request("/api/subs/not-a-uuid/avatar")).status).toBe(400);
	});
});

describe("删订阅", () => {
	it("经面板删掉 → 头像文件跟着删;别的订阅的不动", async () => {
		entries = [sourceEntry("douyin")];
		const avatar = avatarDataUrl("png", PNG_BYTES);
		expect((await post({ ...extSub(), cachedProfile: { name: "甲", avatar } })).status).toBe(200);
		expect(
			(
				await post({
					...extSub({ id: OTHER_ID, externalId: "sec-2" }),
					cachedProfile: { name: "乙", avatar },
				})
			).status,
		).toBe(200);
		expect(await avatarFiles()).toEqual([`${SUB_ID}.png`, `${OTHER_ID}.png`].sort());

		expect((await app.request(`/api/subs/${SUB_ID}`, { method: "DELETE" })).status).toBe(204);

		await vi.waitFor(async () => {
			expect(await avatarFiles()).toEqual([`${OTHER_ID}.png`]);
		});
		expect((await app.request(`/api/subs/${SUB_ID}/avatar`)).status).toBe(404);
	});
});
