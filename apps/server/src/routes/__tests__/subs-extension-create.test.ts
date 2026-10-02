/**
 * 新建订阅(拓展来源的 + B 站来源的)+ 拓展来源订阅的头像文件(ADR-0019 决策 9 / 10 / 49 / 50;ADR-0021 决策 14)。
 *
 * 真的 ConfigStore / SubRuntimeStore / 头像仓(`createAppRuntime`,临时 dataDir)、真的 `createApp` ——
 * 装了哪些拓展从 `extensions.loaded` 那一格递进来,与 `index.ts` 同一条线,所以 app 那头漏接的话
 * 这里的每一条新建都会被判成「没装」。删订阅走真的那条路:DELETE → config-changed →
 * `bindSubscriptionStore` → `subscription-changed` 的 remove → 头像跟着删。
 *
 *  - 宿主核 `extensionId`:装着、v2、清单开了订阅源那一口;**没在跑也行**(订阅是数据,决策 10)。
 *  - 同一个身份(来源 + 外部 id 两格都相等)只许一条(决策 50:身份判重)→ 409。
 *  - 候选带来的资料(名字 / 头像 / 粉丝)种进资料缓存;头像存成文件,资料里是同源的相对地址。
 *  - 头像只收位图,魔数要对得上;不合规矩的整次 400、一样都不落。
 *  - 新建 B 站来源的订阅:外部 id 就是 UID,得是数字(中立的订阅 schema 不认得这条规矩,核在新建这一处);
 *    已有那条整份 POST 回来(启用开关),照旧。
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
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createApp, createCardSkinStore } from "../../app.js";
import type { BootstrapConfig } from "../../config/schema.js";
import { CONFIG_DIR } from "../../config/store.js";
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
	runtime = createAppRuntime(makeBootstrap(dataDir), { dataRoot: dataDir });
	await runtime.configStore.load();
	await runtime.subRuntimeStore.load();
	// index.ts 同一步:订阅仓镜像配置、改动转成 subscription-changed。
	const binding = bindSubscriptionStore({ bus: runtime.bus, configStore: runtime.configStore });
	unbind = () => binding.dispose();
	entries = [sourceEntry("douyin"), PUSH_ONLY, V1];
	app = createApp(runtime, {
		cardSkins: { store: createCardSkinStore(dataDir) },
		extensions: {
			mounts: createExtensionMounts({ logger: silentLogger }),
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
		expect(row).toMatchObject({ identity: { sourceKey: "douyin", externalId: "sec-1" } });
		const profile = row?.cachedProfile;
		expect(profile).toMatchObject({ name: "抖音某人", sign: "", fans: 42 });
		expect(profile?.avatar).toMatch(new RegExp(`^/api/subs/${SUB_ID}/avatar\\?v=[0-9a-f]{12}$`));
		expect(Date.parse(profile?.lastRefreshedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);

		// 落了盘:订阅那个文件里有它(带 identity),头像文件在。
		const disk = JSON.parse(
			await readFile(join(dataDir, ...CONFIG_DIR, "subscriptions.json"), "utf8"),
		) as { subscriptions: Array<{ id: string; identity: unknown }> };
		expect(disk.subscriptions.map((s) => s.id)).toEqual([SUB_ID]);
		expect(disk.subscriptions[0]?.identity).toEqual({ sourceKey: "douyin", externalId: "sec-1" });
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
		["没装", "nope", "not_found", 404],
		["v1 拓展", "oldie", "unsupported", 400],
		["只开了推送那一口", "pusher", "unsupported", 400],
		["清单读不出来", "broken", "unsupported", 400],
	] as const)("%s → %i,点名为什么,一样都不落", async (_label, extensionId, code, status) => {
		entries = [...entries, { id: "broken", dir: "/data/extensions/broken", state: "failed" }];
		const res = await post({
			...extSub({ extensionId }),
			cachedProfile: { name: "某人", avatar: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status).toBe(status);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe(code);
		expect(body.message).toContain(extensionId);
		expect(await listed()).toEqual([]);
		expect(await avatarFiles()).toEqual([]);
		expect(runtime.subRuntimeStore.get(SUB_ID)).toBeUndefined();
	});

	it("同一个拓展名下同一个外部 id 已经订阅过 → 409,点名是谁;别的拓展同一个外部 id 不算重", async () => {
		expect((await post(extSub())).status).toBe(200);

		const dup = await post(extSub({ id: OTHER_ID }));
		expect(dup.status).toBe(409);
		const body = (await dup.json()) as { code: string; message: string };
		expect(body.code).toBe("conflict");
		// 撞的是谁不再靠附加的 `id` 字段说,话里点名。
		expect(body).not.toHaveProperty("id");
		expect(body.message).toContain("douyin");
		expect(body.message).toContain("sec-1");
		expect((await listed()).map((s) => s.id)).toEqual([SUB_ID]);

		entries = [sourceEntry("douyin"), sourceEntry("kuaishou")];
		expect((await post(extSub({ id: OTHER_ID, extensionId: "kuaishou" }))).status).toBe(200);
	});

	it("撞了身份、带着资料与头像 → 409,新的那条一样都不落:不存头像、不种资料", async () => {
		expect((await post({ ...extSub(), cachedProfile: { name: "原来的" } })).status).toBe(200);
		const dup = await post({
			...extSub({ id: OTHER_ID }),
			cachedProfile: { name: "后来的", avatar: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(dup.status).toBe(409);
		expect(await avatarFiles()).toEqual([]);
		expect(runtime.subRuntimeStore.get(OTHER_ID)).toBeUndefined();
		expect(runtime.subRuntimeStore.get(SUB_ID)?.cachedProfile?.name).toBe("原来的");
	});

	it("判重看身份两格:B 站来源与拓展来源的外部 id 是同一串数字也不算重(两个方向都一样)", async () => {
		// 拓展先、B 站后。
		expect((await post(extSub({ externalId: "12345" }))).status).toBe(200);
		expect(
			(
				await post(
					makeEmptySubscription({
						id: OTHER_ID,
						identity: { sourceKey: "bilibili", externalId: "12345" },
					}),
				)
			).status,
		).toBe(200);
		// B 站先、另一个拓展后。
		entries = [sourceEntry("douyin"), sourceEntry("kuaishou")];
		expect(
			(
				await post(
					extSub({
						id: "e1000000-0000-4000-8000-000000000003",
						extensionId: "kuaishou",
						externalId: "12345",
					}),
				)
			).status,
		).toBe(200);
		expect((await listed()).map((s) => s.identity)).toEqual([
			{ sourceKey: "douyin", externalId: "12345" },
			{ sourceKey: "bilibili", externalId: "12345" },
			{ sourceKey: "kuaishou", externalId: "12345" },
		]);
		// 同一身份再来一次才是重。
		const dup = await post(
			extSub({ id: "e1000000-0000-4000-8000-000000000004", externalId: "12345" }),
		);
		expect(dup.status).toBe(409);
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
		const body = (await res.json()) as {
			code: string;
			message: string;
			issues: Array<{ path: string[]; message: string }>;
		};
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("头像");
		expect(body.issues).toEqual([
			{ path: ["cachedProfile", "avatar"], message: expect.any(String) },
		]);
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
		const body = (await res.json()) as { code: string; message: string; issues: unknown[] };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("资料不合规");
		expect(body.issues.length).toBeGreaterThan(0);
		expect(await listed()).toEqual([]);
	});

	it("订阅本身形状不对(外部 id 是空串)→ 400 invalid,与 store 同一个口径(中文话 + 逐格 issues)", async () => {
		const res = await post({ ...extSub({ externalId: "" }), cachedProfile: { name: "某人" } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			code: string;
			message: string;
			issues: Array<{ path: string[] }>;
		};
		expect(body.code).toBe("invalid");
		expect(body.message).toMatch(/^订阅有 \d+ 格不合法：/);
		expect(body.issues).toEqual([expect.objectContaining({ path: ["identity", "externalId"] })]);
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

describe("新建 B 站来源的订阅:外部 id 就是 UID,只能是数字", () => {
	const bili = (externalId: unknown, id = OTHER_ID) => ({
		...makeEmptySubscription({ id, identity: { sourceKey: "bilibili", externalId: "1" } }),
		identity: { sourceKey: "bilibili", externalId },
	});

	it.each([
		["字母", "abc"],
		["数字夹字母", "12a"],
		["空串", ""],
		["带空格", " 123"],
		["小数", "1.5"],
		["负数", "-1"],
		["数字类型(不是字符串)", 12345],
	])(
		"外部 id 是 %s → 400 invalid,点名 identity.externalId,一样都不落",
		async (_label, externalId) => {
			const res = await post(bili(externalId));
			expect(res.status, await res.clone().text()).toBe(400);
			const body = (await res.json()) as {
				code: string;
				message: string;
				issues: Array<{ path: string[]; message: string }>;
			};
			expect(body.code).toBe("invalid");
			expect(body.message).toContain("UID");
			expect(body.issues).toEqual([
				{ path: ["identity", "externalId"], message: expect.any(String) },
			]);
			expect(await listed()).toEqual([]);
			expect(await exists(join(dataDir, "avatars"))).toBe(false);
		},
	);

	it("是数字 → 照常建;身份原样进盘", async () => {
		for (const [id, uid] of [
			[OTHER_ID, "12345"],
			["e1000000-0000-4000-8000-000000000005", "0"],
		] as const) {
			const res = await post(bili(uid, id));
			expect(res.status, await res.clone().text()).toBe(200);
		}
		expect((await listed()).map((s) => s.identity)).toEqual([
			{ sourceKey: "bilibili", externalId: "12345" },
			{ sourceKey: "bilibili", externalId: "0" },
		]);
	});

	it("只核新建:已有的 B 站订阅整份 POST 回来(身份不变)不再核,别的字段照改", async () => {
		// 盘上已经有一条外部 id 不是数字的 B 站来源订阅(比如手改过文件):它不是「新建」,这一道不拦它。
		const odd = bili("not-a-number");
		await runtime.configStore.upsertSubscription(odd as never);
		const res = await post({ ...odd, enabled: false });
		expect(res.status, await res.clone().text()).toBe(200);
		expect((await listed()).find((s) => s.id === OTHER_ID)?.enabled).toBe(false);
	});

	it("拓展来源的订阅不核数字:外部 id 什么字符都行", async () => {
		expect((await post(extSub({ externalId: "MS4wLjABAAAA-sec_uid" }))).status).toBe(200);
	});

	it("同一个 UID 已经订阅过 → 409 conflict,点名来源与 UID;只留原来那条", async () => {
		expect((await post(bili("12345"))).status).toBe(200);
		const dup = await post(bili("12345", "e1000000-0000-4000-8000-000000000006"));
		expect(dup.status).toBe(409);
		const body = (await dup.json()) as { code: string; message: string };
		expect(body.code).toBe("conflict");
		expect(body.message).toContain("bilibili");
		expect(body.message).toContain("12345");
		expect((await listed()).map((s) => s.id)).toEqual([OTHER_ID]);
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
		const bili = makeEmptySubscription({
			id: OTHER_ID,
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		expect((await post(bili)).status).toBe(200);
		expect((await listed()).map((s) => s.id)).toEqual([OTHER_ID]);
		expect(await exists(join(dataDir, "avatars"))).toBe(false);
	});
});

describe("GET /api/subs/:id/avatar", () => {
	it("没有头像 → 404 not_found;id 不是 uuid → 400 invalid", async () => {
		const missing = await app.request(`/api/subs/${SUB_ID}/avatar`);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ code: "not_found", message: "这条订阅没有头像" });
		const bad = await app.request("/api/subs/not-a-uuid/avatar");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ code: "invalid", message: "订阅 id 要是 uuid" });
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
