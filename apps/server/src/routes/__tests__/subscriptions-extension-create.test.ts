/**
 * 新建订阅(拓展来源的 + B 站来源的)+ 拓展来源订阅的头像进图库(ADR-0019 决策 9 / 10 / 49 / 50;ADR-0021 决策 14;
 * 头像进图库见 ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗)。
 *
 * 真的 ConfigStore / SubscriptionStateStore / 图库(`createAppRuntime`,临时 dataDir)、真的 `createApp` ——
 * 装了哪些拓展从 `extensions.loaded` 那一格递进来,与 `index.ts` 同一条线,所以 app 那头漏接的话
 * 这里的每一条新建都会被判成「没装」。删订阅走真的那条路:DELETE → config-changed → 开机那一步的孤儿清理
 * (`pruneOrphanSubscriptionState`)丢掉资料缓存里的这一条 → 头像不再有人引用 → 图库清扫收走。
 *
 *  - 宿主核 `extensionId`:装着、清单开了订阅源那一口;**没在跑也行**(订阅是数据,决策 10)。
 *  - 同一个身份(来源 + 外部 id 两格都相等)只许一条(决策 50:身份判重)→ 409。
 *  - 候选带来的资料(名字 / 头像 / 粉丝)种进资料缓存:请求里头像是 `cachedProfile.avatarUrl`(位图 data URL,
 *    它是个网址),存进图库后资料里是图库引用 `avatar`。
 *  - 头像只收位图,魔数要对得上;不合规矩的整次 400、一样都不落。
 *  - 新建 B 站来源的订阅:外部 id 就是 UID,得是数字(中立的订阅 schema 不认得这条规矩,核在新建这一处);
 *    已有那条整份 POST 回来(启用开关),照旧。
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionView } from "@bilibili-notify/contract";
import { makeEmptySubscription } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	avatarDataUrl,
	JPEG_BYTES,
	PNG_BYTES,
	WEBP_BYTES,
} from "../../__tests__/support/avatar-fixtures.js";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createApp, createCardSkinStore } from "../../app.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BILI_SOURCE_DESCRIPTOR } from "../../bilibili/source.js";
import type { BootstrapConfig } from "../../config/schema.js";
import { CONFIG_DIR } from "../../config/store.js";
import type { ExtensionEntry } from "../../extensions/loader.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { IMAGE_GRACE_MS, isValidImageRef } from "../../images/image-store.js";
import { type AppRuntime, createAppRuntime } from "../../runtime/bootstrap.js";
import { dataPath } from "../../runtime/roots.js";
import { pruneOrphanSubscriptionState } from "../../runtime/subscription-state-store.js";
import { bindSubscriptionStore } from "../../runtime/subscription-store.js";

const SUB_ID = "e1000000-0000-4000-8000-000000000001";
const OTHER_ID = "e1000000-0000-4000-8000-000000000002";

function sourceEntry(
	id: string,
	state: ExtensionEntry["state"] = "running",
	display: { externalIdRegex?: string } = {},
): ExtensionEntry {
	return {
		id,
		dir: `/data/extensions/${id}`,
		state,
		manifest: {
			id,
			name: `${id} 订阅源`,
			description: "一句话说明",
			version: "0.1.0",
			apiVersion: 1,
			contributes: {
				subscription: {
					label: "抖音",
					shortLabel: "抖",
					color: "#fe2c55",
					...display,
					supportedFeatures: ["post"],
				},
			},
		},
	};
}

/** 只开了推送那一口。 */
const PUSH_ONLY: ExtensionEntry = {
	id: "pusher",
	dir: "/data/extensions/pusher",
	state: "running",
	manifest: {
		id: "pusher",
		name: "只推送",
		description: "一句话说明",
		version: "0.1.0",
		apiVersion: 1,
		contributes: { push: { label: "推", shortLabel: "推", color: "#123456" } },
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
	runtime = createAppRuntime(
		makeBootstrap(dataDir),
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
	await runtime.configStore.load();
	await runtime.subscriptionStateStore.load();
	// B 站来源照真实开机那一步登记进来源登记表(外部 id 的格式取自它的描述符,路由不自己认 B 站)。
	await runtime.sourceRegistry.register(
		"bilibili",
		{
			descriptor: BILI_SOURCE_DESCRIPTOR,
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
		},
		{ logger: silentLogger } as never,
	);
	// index.ts 同一步:订阅仓镜像配置、改动转成 subscription-changed。
	const binding = bindSubscriptionStore({ bus: runtime.bus, configStore: runtime.configStore });
	unbind = () => binding.dispose();
	entries = [sourceEntry("douyin"), PUSH_ONLY];
	app = createApp(runtime, {
		cardSkins: { store: createCardSkinStore(dataDir) },
		extensions: {
			mounts: createExtensionMounts({ logger: silentLogger }),
			loaded: () => entries,
			status: () => undefined,
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
	return app.request("/api/subscriptions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function listed(): Promise<SubscriptionView[]> {
	return (await (await app.request("/api/subscriptions")).json()) as SubscriptionView[];
}

/** 图库里此刻有哪些图(目录还没建就是空)。 */
async function imageFiles(): Promise<string[]> {
	try {
		return (await readdir(dataPath(dataDir, "images"))).sort();
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
	it("候选的资料种进缓存、头像存进图库;资料里是图库引用,读口拿回原样的字节", async () => {
		const before = Date.now();
		const res = await post({
			...extSub(),
			cachedProfile: {
				name: "抖音某人",
				avatarUrl: avatarDataUrl("png", PNG_BYTES),
				followers: 42,
				// 客户端给的这两格不收:签名没人报过,刷新时间是服务端的事。
				sign: "客户端编的",
				lastRefreshedAt: "1999-01-01T00:00:00.000Z",
			},
		});
		expect(res.status, await res.clone().text()).toBe(200);

		const row = (await listed()).find((s) => s.id === SUB_ID);
		expect(row).toMatchObject({ identity: { sourceKey: "douyin", externalId: "sec-1" } });
		const profile = row?.cachedProfile;
		expect(profile).toMatchObject({ name: "抖音某人", followers: 42 });
		// 请求里的 data URL 是网址、落进图库;回来的资料里只有引用,没有那个 data URL。
		expect(profile?.avatar && isValidImageRef(profile.avatar)).toBe(true);
		expect(profile?.avatar).toMatch(/\.png$/);
		expect(profile).not.toHaveProperty("avatarUrl");
		expect(Date.parse(profile?.refreshedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);

		// 落了盘:订阅那个文件里有它(带 identity),图在图库里。
		const disk = JSON.parse(
			await readFile(join(dataDir, ...CONFIG_DIR, "subscriptions.json"), "utf8"),
		) as { subscriptions: Array<{ id: string; identity: unknown }> };
		expect(disk.subscriptions.map((s) => s.id)).toEqual([SUB_ID]);
		expect(disk.subscriptions[0]?.identity).toEqual({ sourceKey: "douyin", externalId: "sec-1" });
		expect(await imageFiles()).toEqual([profile?.avatar]);

		const img = await app.request(`/api/images/${profile?.avatar}`);
		expect(img.status).toBe(200);
		expect(Buffer.from(await img.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
		expect(img.headers.get("content-type")).toBe("image/png");
	});

	it("新建请求只认 followers;旧的 fans 按 zod 现状当多余键丢掉", async () => {
		const withOldName = await post({
			...extSub({ id: OTHER_ID }),
			cachedProfile: { name: "只用旧名的人", fans: 99 },
		});
		expect(withOldName.status, await withOldName.clone().text()).toBe(200);

		const profile = (await listed()).find((s) => s.id === OTHER_ID)?.cachedProfile;
		expect(profile).toMatchObject({ name: "只用旧名的人" });
		expect(profile).not.toHaveProperty("bio");
		expect(profile && "fans" in profile).toBe(false);
	});

	it("不知道粉丝数就不写这一格(写 0 是撒谎);没给头像 → 头像两格都缺、不建图", async () => {
		const res = await post({ ...extSub(), cachedProfile: { name: "没头像的人" } });
		expect(res.status, await res.clone().text()).toBe(200);
		const profile = (await listed()).find((s) => s.id === SUB_ID)?.cachedProfile;
		expect(profile).toMatchObject({ name: "没头像的人" });
		expect(profile).not.toHaveProperty("bio");
		expect(profile && "fans" in profile).toBe(false);
		expect(profile && "avatar" in profile).toBe(false);
		expect(profile && "avatarUrl" in profile).toBe(false);
		expect(await imageFiles()).toEqual([]);
	});

	it("拓展收到新建通知就先报了资料 → 种资料不盖掉它,候选的头像也不存", async () => {
		// 真实那一路:订阅落盘 → 拓展收到通知 → `ctx.reportProfile` 经全进程唯一的资料缓存写口写进来。
		const listening = runtime.bus.on("subscription-changed", ({ ops }) => {
			if (ops.some((op) => op.kind === "add" && op.sub.id === SUB_ID)) {
				void runtime.profileCache.write(SUB_ID, { name: "拓展先报的" });
			}
		});
		try {
			const res = await post({
				...extSub(),
				cachedProfile: { name: "候选", avatarUrl: avatarDataUrl("png", PNG_BYTES), followers: 1 },
			});
			expect(res.status, await res.clone().text()).toBe(200);
		} finally {
			listening.dispose();
		}

		const profile = runtime.subscriptionStateStore.get(SUB_ID)?.cachedProfile;
		expect(profile?.name).toBe("拓展先报的");
		expect(profile && "followers" in profile).toBe(false);
		expect(await imageFiles()).toEqual([]);
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
		["只开了推送那一口", "pusher", "unsupported", 400],
		["清单读不出来", "broken", "unsupported", 400],
	] as const)("%s → %i,点名为什么,一样都不落", async (_label, extensionId, code, status) => {
		entries = [...entries, { id: "broken", dir: "/data/extensions/broken", state: "failed" }];
		const res = await post({
			...extSub({ extensionId }),
			cachedProfile: { name: "某人", avatarUrl: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status).toBe(status);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe(code);
		expect(body.message).toContain(extensionId);
		expect(await listed()).toEqual([]);
		expect(await imageFiles()).toEqual([]);
		expect(runtime.subscriptionStateStore.get(SUB_ID)).toBeUndefined();
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
			cachedProfile: { name: "后来的", avatarUrl: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(dup.status).toBe(409);
		expect(await imageFiles()).toEqual([]);
		expect(runtime.subscriptionStateStore.get(OTHER_ID)).toBeUndefined();
		expect(runtime.subscriptionStateStore.get(SUB_ID)?.cachedProfile?.name).toBe("原来的");
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
	])("头像是%s → 400,点名 cachedProfile.avatarUrl,一样都不落", async (_label, avatarUrl) => {
		const res = await post({ ...extSub(), cachedProfile: { name: "某人", avatarUrl } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			code: string;
			message: string;
			issues: Array<{ path: string[]; message: string }>;
		};
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("头像");
		expect(body.issues).toEqual([
			{ path: ["cachedProfile", "avatarUrl"], message: expect.any(String) },
		]);
		expect(await listed()).toEqual([]);
		expect(await imageFiles()).toEqual([]);
	});

	it.each([
		["名字是空串", { name: "" }, ["cachedProfile", "name"]],
		["粉丝数是负的", { name: "某人", followers: -1 }, ["cachedProfile", "followers"]],
		["不是对象", "某人", ["cachedProfile"]],
	])("资料里%s → 400,issues 点名对应格", async (_label, cachedProfile, issuePath) => {
		const res = await post({ ...extSub(), cachedProfile });
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			code: string;
			message: string;
			issues: Array<{ path: string[]; message: string }>;
		};
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("资料不合规");
		expect(body.issues).toContainEqual(
			expect.objectContaining({ path: issuePath, message: expect.any(String) }),
		);
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

	it("订阅建好之后头像存不进图库 → 订阅照建,资料照种、只是没有头像", async () => {
		// 让 `<dataRoot>/images` 是个文件:建目录那一步必挂。
		await writeFile(dataPath(dataDir, "images"), "挡路");
		const warn = vi.spyOn(runtime.serviceCtx.logger, "warn");
		const res = await post({
			...extSub(),
			cachedProfile: { name: "某人", avatarUrl: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status, await res.clone().text()).toBe(200);
		const profile = (await listed()).find((s) => s.id === SUB_ID)?.cachedProfile;
		expect(profile).toMatchObject({ name: "某人" });
		expect(profile && "avatar" in profile).toBe(false);
		expect(warn).toHaveBeenCalled();
	});
});

/**
 * 新建订阅只有一道门(4-15,对拍 N01):来源认不认得问来源登记表(在册就认),不在册的再看装没装成订阅源拓展
 * (停着也行)。从前键不是 `bilibili` 的一律当拓展,在册的内置来源经接口建不出订阅;B 站单走一支、带来的资料
 * 被剥掉。
 */
describe("新建订阅只有一道门:来源问登记表,资料一律由候选种", () => {
	// 验红:把门改回「键不是 bilibili 就只认装着的拓展」,这条红(回 404「没装」)。
	it("在册的内置来源(不是拓展)经接口建得出订阅,候选资料照样种进缓存", async () => {
		await runtime.sourceRegistry.register(
			"acme.local",
			{
				descriptor: { label: "示例平台", supportedFeatures: ["post"] },
				searchCreators: noCandidates,
				fetchProfile: noProfile,
				start: async () => {},
				stop: async () => {},
			},
			{ logger: silentLogger } as never,
		);
		const sub = makeEmptySubscription({
			id: OTHER_ID,
			identity: { sourceKey: "acme.local", externalId: "a-1" },
		});
		const res = await post({ ...sub, cachedProfile: { name: "示例作者", followers: 3 } });
		expect(res.status).toBe(200);
		const row = (await listed()).find((s) => s.id === OTHER_ID);
		expect(row?.cachedProfile).toMatchObject({ name: "示例作者", followers: 3 });
	});

	// 验红:B 站那一支照旧把 cachedProfile 剥掉,这条红(资料是空的)。
	it("B 站订阅也由候选种资料:名字、粉丝,头像存进图库", async () => {
		const bili = makeEmptySubscription({
			id: OTHER_ID,
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		const res = await post({
			...bili,
			cachedProfile: { name: "某 UP", followers: 9, avatarUrl: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status).toBe(200);
		const row = (await listed()).find((s) => s.id === OTHER_ID);
		expect(row?.cachedProfile).toMatchObject({ name: "某 UP", followers: 9 });
		expect(isValidImageRef(String(row?.cachedProfile?.avatar))).toBe(true);
	});

	it("既不在册、也没装成拓展的键 → 404,点名是哪个键,一样都不落", async () => {
		const sub = makeEmptySubscription({
			id: OTHER_ID,
			identity: { sourceKey: "nowhere", externalId: "x" },
		});
		const res = await post({ ...sub, cachedProfile: { name: "某人" } });
		expect(res.status).toBe(404);
		expect(((await res.json()) as { message: string }).message).toContain("nowhere");
		expect(await listed()).toEqual([]);
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
			// 话里点的是描述符的名字,核心里没有「UID」这类平台专有的字。
			expect(body.message).toContain("B 站");
			expect(body.issues).toEqual([
				{ path: ["identity", "externalId"], message: expect.any(String) },
			]);
			expect(await listed()).toEqual([]);
			expect(await exists(dataPath(dataDir, "images"))).toBe(false);
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

describe("新建拓展订阅:外部 id 的格式由清单声明(externalIdRegex)", () => {
	beforeEach(() => {
		entries = [sourceEntry("typed", "running", { externalIdRegex: "^\\d+$" }), sourceEntry("free")];
	});

	it.each([
		["字母", "abc"],
		["数字夹字母", "12a"],
		["空串", ""],
	])(
		"声明了 ^\\d+$:外部 id 是%s → 400 invalid,点名 identity.externalId,一样都不落",
		async (_l, id) => {
			const res = await post(extSub({ extensionId: "typed", externalId: id }));
			expect(res.status, await res.clone().text()).toBe(400);
			const body = (await res.json()) as {
				code: string;
				message: string;
				issues: Array<{ path: string[] }>;
			};
			expect(body.code).toBe("invalid");
			expect(body.message).toContain("抖音");
			expect(body.issues).toEqual([
				{ path: ["identity", "externalId"], message: expect.any(String) },
			]);
			expect(await listed()).toEqual([]);
		},
	);

	it("声明了 ^\\d+$:合格式的 123 照常建成", async () => {
		const res = await post(extSub({ extensionId: "typed", externalId: "123" }));
		expect(res.status, await res.clone().text()).toBe(200);
		expect((await listed()).map((s) => s.identity)).toEqual([
			{ sourceKey: "typed", externalId: "123" },
		]);
	});

	it("没声明格式的拓展:abc 照常建成", async () => {
		const res = await post(extSub({ extensionId: "free", externalId: "abc" }));
		expect(res.status, await res.clone().text()).toBe(200);
	});

	it("只核新建:已有的订阅整份 POST 回来(身份不变)不再核", async () => {
		// 清单后来才加了格式声明:盘上早就有的、不合格式的那一条不是「新建」。
		entries = [sourceEntry("free")];
		expect((await post(extSub({ extensionId: "free", externalId: "abc" }))).status).toBe(200);
		entries = [sourceEntry("free", "running", { externalIdRegex: "^\\d+$" })];
		const res = await post(extSub({ extensionId: "free", externalId: "abc", enabled: false }));
		expect(res.status, await res.clone().text()).toBe(200);
		expect((await listed()).find((s) => s.id === SUB_ID)?.enabled).toBe(false);
	});
});

describe("已有的照旧", () => {
	it("已有的拓展订阅整份 POST 回来(启用开关)→ 改得动;带着资料也不重种、不存头像", async () => {
		expect((await post({ ...extSub(), cachedProfile: { name: "原来的名字" } })).status).toBe(200);
		const res = await post({
			...extSub({ enabled: false }),
			cachedProfile: { name: "别的名字", avatarUrl: avatarDataUrl("png", PNG_BYTES) },
		});
		expect(res.status).toBe(200);
		const row = (await listed()).find((s) => s.id === SUB_ID);
		expect(row?.enabled).toBe(false);
		expect(row?.cachedProfile?.name).toBe("原来的名字");
		expect(await imageFiles()).toEqual([]);
	});

	it("B 站订阅新建照旧,不碰图库", async () => {
		const bili = makeEmptySubscription({
			id: OTHER_ID,
			identity: { sourceKey: "bilibili", externalId: "12345" },
		});
		expect((await post(bili)).status).toBe(200);
		expect((await listed()).map((s) => s.id)).toEqual([OTHER_ID]);
		expect(await exists(dataPath(dataDir, "images"))).toBe(false);
	});
});

describe("订阅头像的读口", () => {
	it("订阅自己的头像读口没有了:头像走图库的 /api/images/<引用>(接线守卫钉着老路径 404)", async () => {
		expect((await app.request(`/api/subscriptions/${SUB_ID}/avatar`)).status).toBe(404);
	});
});

describe("删订阅", () => {
	/** 宽限期过了:清扫按「一天多以后」的时钟算。 */
	const afterGrace = () => new Date(Date.now() + IMAGE_GRACE_MS + 60 * 60 * 1000);
	/** 开机那一步的孤儿清理(运行中是 ProfileRefresh 听 subscription-changed 做同一件事)。 */
	const dropOrphanProfiles = () =>
		pruneOrphanSubscriptionState(runtime.subscriptionStateStore, {
			getSubscriptionIds: () => runtime.configStore.getSubscriptionIds(),
		});

	it("经面板删掉 → 资料没了,头像不再有人引用,清扫收走;另一条订阅用着同一张图时不收", async () => {
		entries = [sourceEntry("douyin")];
		const avatarUrl = avatarDataUrl("png", PNG_BYTES);
		expect((await post({ ...extSub(), cachedProfile: { name: "甲", avatarUrl } })).status).toBe(
			200,
		);
		expect(
			(
				await post({
					...extSub({ id: OTHER_ID, externalId: "sec-2" }),
					cachedProfile: { name: "乙", avatarUrl },
				})
			).status,
		).toBe(200);
		// 同一份字节,图库里只有一张。
		const shared = (await imageFiles())[0];
		expect(await imageFiles()).toEqual([shared]);

		expect((await app.request(`/api/subscriptions/${SUB_ID}`, { method: "DELETE" })).status).toBe(
			204,
		);
		await dropOrphanProfiles();
		expect(runtime.subscriptionStateStore.get(SUB_ID)).toBeUndefined();
		expect((await runtime.imageStore.sweep({ now: afterGrace() })).removed).toEqual([]);
		expect(await imageFiles()).toEqual([shared]);

		expect((await app.request(`/api/subscriptions/${OTHER_ID}`, { method: "DELETE" })).status).toBe(
			204,
		);
		await dropOrphanProfiles();
		expect((await runtime.imageStore.sweep({ now: afterGrace() })).removed).toEqual([shared]);
		expect(await imageFiles()).toEqual([]);
	});
});
