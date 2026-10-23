/**
 * 单元测试 — /api/subscriptions 的「外置 runtime 字段回 join」+「POST 经资料刷新引擎拉资料」。
 *
 * cachedProfile 已从 Subscription 外置(M2)。DTO 必须把 cachedProfile 从 SubRuntimeStore join 回(有才带,
 * 无则 undefined)。从前还补一个恒为「未知」的 `state` 常量,没人写过它,1.0 第 2 期 ⑫ 删掉 —— 这里钉着它不再回来。
 * POST 新建后在册来源经资料刷新的单条口拉一次并等它落定;失败 best-effort 不致命;
 * 引擎没起时跳过。GET/POST/PATCH 响应都走同一 toDTO,保证前端缓存一致。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { BILI_SOURCE_DESCRIPTOR } from "../../bilibili/source.js";
import { ConfigValidationError } from "../../config/store.js";
import { createSubscriptionsRoute } from "../subscriptions.js";
import type { RouteDeps } from "../types.js";

const SUB = {
	id: "11111111-1111-1111-1111-111111111111",
	identity: { sourceKey: "bilibili", externalId: "12345" },
	enabled: true,
	tagIds: [],
	routing: {},
	extras: { atAllPost: {}, atAllLiveStart: {}, wordcloud: {}, liveSummary: {} },
	overrides: {},
	specialViewers: [],
};

const PROFILE = {
	name: "测试UP",
	avatarUrl: "https://example.com/a.png",
	sign: "签名",
	fans: 1234,
	lastRefreshedAt: "2026-05-19T00:00:00.000Z",
};

interface Harness {
	app: ReturnType<typeof createSubscriptionsRoute>;
	getSubscriptions: ReturnType<typeof vi.fn>;
	upsertSubscription: ReturnType<typeof vi.fn>;
	patchSubscription: ReturnType<typeof vi.fn>;
	rtGet: ReturnType<typeof vi.fn>;
	rtPatch: ReturnType<typeof vi.fn>;
	follow: ReturnType<typeof vi.fn>;
	refreshSubscription: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: {
	subs?: unknown[];
	rtRecord?: Record<string, unknown>;
	engines?: "ok" | "null";
	/** 单条资料刷新引擎:ok=写一份假资料;null=引擎没起;fail=照常返回但不写;throw=刷新失败。 */
	profileRefresh?: "ok" | "null" | "fail" | "throw";
	/** follow() 的结果:ok=已关注成功;already=22014 已关注过;fail=业务码失败;throw=网络炸。 */
	follow?: "ok" | "already" | "fail" | "throw";
	/** true = 存储里原本没有这条订阅(POST 是新建);缺省 = 已经在(POST 是整份回来改)。 */
	fresh?: boolean;
}): Harness {
	const subs = opts?.subs ?? [SUB];
	const rtRecord = { ...opts?.rtRecord };
	const enginesMode = opts?.engines ?? "ok";
	const refreshMode = opts?.profileRefresh ?? "ok";

	// 新建:存储里原本没有这条,upsert 之后才有(POST 靠这个分辨「新建」与「整份回来改」)。
	let stored = !opts?.fresh;
	const getSubscriptions = vi.fn(() => (stored ? subs : []));
	const upsertSubscription = vi.fn(async () => {
		stored = true;
	});
	const patchSubscription = vi.fn(async (_id: string, _patch: unknown) => SUB);
	const rtGet = vi.fn((id: string) => rtRecord[id]);
	const rtPatch = vi.fn(async (id: string, patch: Record<string, unknown>) => {
		rtRecord[id] = { ...(rtRecord[id] as Record<string, unknown> | undefined), ...patch };
	});
	const refreshSubscription = vi.fn(async (id: string) => {
		if (refreshMode === "throw") throw new Error("refresh failed");
		if (refreshMode === "fail" || refreshMode === "null") return;
		await rtPatch(id, {
			cachedProfile: {
				name: PROFILE.name,
				sign: PROFILE.sign,
				fans: PROFILE.fans,
				lastRefreshedAt: PROFILE.lastRefreshedAt,
			},
		});
	});

	const followMode = opts?.follow ?? "ok";
	const follow = vi.fn(async (_fid: string) => {
		if (followMode === "throw") throw new Error("network down");
		if (followMode === "already") return { code: 22014, message: "已关注" };
		if (followMode === "fail") return { code: 22003, message: "对方已将你拉黑" };
		return { code: 0, message: "0" };
	});

	const engines = enginesMode === "null" ? null : { api: { follow } };

	const deps = {
		store: {
			getSubscriptions,
			upsertSubscription,
			patchSubscription,
			getGlobals: () => makeDefaultGlobalConfig(),
		},
		runtime: {
			serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
			subRuntimeStore: { get: rtGet, patch: rtPatch },
			// 新建订阅按来源描述符核外部 id:B 站的描述符从登记表来。
			sourceRegistry: {
				get: (key: string) =>
					key === SUB.identity.sourceKey ? { descriptor: BILI_SOURCE_DESCRIPTOR } : undefined,
			},
			engines,
			profileRefresh: refreshMode === "null" ? null : { refreshSubscription },
		},
	} as unknown as RouteDeps;

	return {
		app: createSubscriptionsRoute(deps),
		getSubscriptions,
		upsertSubscription,
		patchSubscription,
		rtGet,
		rtPatch,
		follow,
		refreshSubscription,
	};
}

describe("/api/subscriptions GET — runtime 字段 join", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("无 cachedProfile 时返回 undefined,也不带早已删掉的 state", async () => {
		const h = makeHarness();
		const res = await h.app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		const row = body[0] as Record<string, unknown>;
		expect(row.cachedProfile).toBeUndefined();
		expect(row).not.toHaveProperty("state");
		// 配置字段透传
		expect(row.id).toBe(SUB.id);
		expect(row.identity).toEqual(SUB.identity);
	});

	it("有 cachedProfile 时 join 回 DTO", async () => {
		const h = makeHarness({
			rtRecord: {
				[SUB.id]: {
					cachedProfile: PROFILE,
				},
			},
		});
		const res = await h.app.request("/");
		const body = (await res.json()) as Array<Record<string, unknown>>;
		const row = body[0] as Record<string, unknown>;
		expect(row.cachedProfile).toEqual(PROFILE);
		expect(row).not.toHaveProperty("state");
	});
});

// 「未关注」是服务端写进运行时状态、随 DTO 带给面板的(不是面板自己算的)。写下的 `followed:false`
// 会一直留着 —— 主人后来把作品关了、或把订阅停了,这条订阅已经不需要关注,DTO 就不该再带它,
// 否则卡片上还挂着「未关注 —— 收不到动态」,主人会以为出了问题。
describe("/api/subscriptions GET — 不需要关注的订阅不带关注状态", () => {
	const unfollowed = { followed: false, followError: "对方已将你拉黑" };

	it("开着作品的启用订阅:照常带 followed / followError", async () => {
		const h = makeHarness({ rtRecord: { [SUB.id]: unfollowed } });
		const body = (await (await h.app.request("/")).json()) as Array<Record<string, unknown>>;
		expect(body[0]?.followed).toBe(false);
		expect(body[0]?.followError).toBe("对方已将你拉黑");
	});

	it("只开直播(作品关着)的订阅:不带", async () => {
		const liveOnly = { ...SUB, overrides: { features: { post: false } } };
		const h = makeHarness({ subs: [liveOnly], rtRecord: { [SUB.id]: unfollowed } });
		const body = (await (await h.app.request("/")).json()) as Array<Record<string, unknown>>;
		expect("followed" in (body[0] ?? {})).toBe(false);
		expect("followError" in (body[0] ?? {})).toBe(false);
	});

	it("停用的订阅:不带", async () => {
		const off = { ...SUB, enabled: false };
		const h = makeHarness({ subs: [off], rtRecord: { [SUB.id]: unfollowed } });
		const body = (await (await h.app.request("/")).json()) as Array<Record<string, unknown>>;
		expect("followed" in (body[0] ?? {})).toBe(false);
	});
});

/** POST 期间真正写进资料缓存的那些 runtime patch(关注状态不算)。 */
function cachedProfileCalls(h: Harness) {
	return h.rtPatch.mock.calls.filter(
		([, patch]) => typeof patch === "object" && patch !== null && "cachedProfile" in patch,
	);
}

describe("/api/subscriptions POST — 新订阅经资料刷新引擎拉资料", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("新 sub 且引擎就绪 → 等单条刷新拉一次,回应带资料", async () => {
		const h = makeHarness({ rtRecord: {}, fresh: true });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.refreshSubscription).toHaveBeenCalledTimes(1);
		expect(h.refreshSubscription).toHaveBeenCalledWith(SUB.id);
		expect(cachedProfileCalls(h)).toHaveLength(1);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body[0]?.cachedProfile).toMatchObject({ name: PROFILE.name, fans: PROFILE.fans });
		expect(body[0]).not.toHaveProperty("state");
	});

	it("已有资料 → 跳过单条刷新(bounded,不重复拉资料)", async () => {
		const h = makeHarness({ fresh: true, rtRecord: { [SUB.id]: { cachedProfile: PROFILE } } });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.refreshSubscription).not.toHaveBeenCalled();
	});

	it("资料刷新引擎没起 → 跳过,不致命(200)", async () => {
		const h = makeHarness({ fresh: true, profileRefresh: "null" });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.refreshSubscription).not.toHaveBeenCalled();
	});

	it("单条刷新抛错 → best-effort,POST 仍 200、不写资料", async () => {
		const h = makeHarness({ fresh: true, profileRefresh: "throw" });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.refreshSubscription).toHaveBeenCalledOnce();
		expect(cachedProfileCalls(h)).toHaveLength(0);
	});

	it("来源失败 → 单条刷新照常落定,POST 仍 200、不写资料", async () => {
		const h = makeHarness({ fresh: true, profileRefresh: "fail" });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.refreshSubscription).toHaveBeenCalledOnce();
		expect(cachedProfileCalls(h)).toHaveLength(0);
	});

	it("无效 JSON body → 400,不 upsert", async () => {
		const h = makeHarness();
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "请求体不是合法的 JSON" });
		expect(h.upsertSubscription).not.toHaveBeenCalled();
	});
});

describe("/api/subscriptions PATCH — 响应同样 join", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("PATCH 返回单条 joined DTO(cachedProfile)", async () => {
		const h = makeHarness({ rtRecord: { [SUB.id]: { cachedProfile: PROFILE } } });
		const res = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.cachedProfile).toEqual(PROFILE);
		expect(body).not.toHaveProperty("state");
		expect(h.patchSubscription).toHaveBeenCalledWith(SUB.id, { enabled: false });
	});

	it("patchSubscription 抛 ConfigValidationError(not_found)→ 404,按码回、不嗅文案", async () => {
		const h = makeHarness();
		h.patchSubscription.mockRejectedValueOnce(
			ConfigValidationError.notFound("subscriptions", `没有 id 为 ${SUB.id} 的订阅`),
		);
		const res = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			code: "not_found",
			message: `没有 id 为 ${SUB.id} 的订阅`,
		});
	});

	it("patchSubscription 抛校验不过 → 400 invalid,逐格 issues 原样带上、scope 不上线", async () => {
		const h = makeHarness();
		h.patchSubscription.mockRejectedValueOnce(
			ConfigValidationError.invalid(
				"subscriptions",
				"订阅有 1 格不合法：identity.externalId：不能为空",
				[{ path: ["identity", "externalId"], message: "不能为空" }],
			),
		);
		const res = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identity: { externalId: "" } }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: "订阅有 1 格不合法：identity.externalId：不能为空",
			issues: [{ path: ["identity", "externalId"], message: "不能为空" }],
		});
	});

	it("PATCH 体不是对象 → 400 invalid,不进 store", async () => {
		const h = makeHarness();
		const res = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: "[1]",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
		expect(h.patchSubscription).not.toHaveBeenCalled();
	});

	it("DELETE 没这条订阅 → 404 not_found", async () => {
		const app = createSubscriptionsRoute({
			store: { getSubscriptions: () => [], deleteSubscription: async () => false },
			runtime: {
				serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
				subRuntimeStore: { get: () => undefined },
				engines: null,
			},
		} as unknown as RouteDeps);
		const res = await app.request("/ghost", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这条订阅" });
	});
});

/**
 * POST 自动关注该 UP。
 *
 * 动态是从 `feed/all`(**关注流**)拉的 —— 只会返回你已关注的人的动态。所以订阅一个
 * UP 却不去关注他,等于订阅了个寂寞:配置里有这条记录,动态流里永远没有他,一条都推
 * 不出来。koishi 端一直在 subscription-loader 里 follow,独立端**从来没做过**。
 */
describe("/api/subscriptions POST — 自动关注该 UP", () => {
	beforeEach(() => vi.restoreAllMocks());

	async function post(h: Harness, body: unknown = SUB) {
		return h.app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("新增订阅 → 去 B 站关注该 UP(否则 feed/all 里根本没有他的动态)", async () => {
		const h = makeHarness({ fresh: true });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.follow).toHaveBeenCalledWith(SUB.identity.externalId);
	});

	// 「关了就不查」:关注只为拉到动态,直播用不着。关注是写接口,最招风控。
	it("新建一条没开作品的订阅(只开直播)→ 不关注,也不写关注状态", async () => {
		const liveOnly = { ...SUB, overrides: { features: { post: false } } };
		const h = makeHarness({ fresh: true, subs: [liveOnly] });
		const res = await post(h, liveOnly);

		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.follow).not.toHaveBeenCalled();
		expect(h.rtPatch).not.toHaveBeenCalledWith(SUB.id, expect.objectContaining({ followed: true }));
		expect(h.rtPatch).not.toHaveBeenCalledWith(
			SUB.id,
			expect.objectContaining({ followed: false }),
		);
	});

	it("新建一条停用的订阅 → 不关注", async () => {
		const off = { ...SUB, enabled: false };
		const h = makeHarness({ fresh: true, subs: [off] });
		await post(h, off);

		expect(h.follow).not.toHaveBeenCalled();
	});

	it("整份 POST 回来改一条已有的订阅(面板的启用开关)→ 不在这里关注:开关翻开补关注归引擎听订阅变更去做", async () => {
		const h = makeHarness(); // 默认:存储里已经有这条
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.follow).not.toHaveBeenCalled();
	});

	it("已经关注过(22014) → 视为成功,不当失败报", async () => {
		const h = makeHarness({ fresh: true, follow: "already" });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.rtPatch).toHaveBeenCalledWith(SUB.id, expect.objectContaining({ followed: true }));
	});

	it("关注失败 → 订阅照建,但把「未关注」如实记下(别让用户以为好了)", async () => {
		const h = makeHarness({ fresh: true, follow: "fail" });
		const res = await post(h);

		// 主人拍板:仍创建。订阅记录不能凭空消失。
		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);

		// 状态落进 SubRuntimeStore → DTO 带给前端 → 订阅卡片能持续显示「未关注」,
		// 而不是一闪而过的 toast。这条订阅现在是收不到动态的,用户有权一直看见。
		expect(h.rtPatch).toHaveBeenCalledWith(
			SUB.id,
			expect.objectContaining({ followed: false, followError: expect.stringContaining("拉黑") }),
		);
	});

	it("关注请求直接抛(断网)→ 同样不阻断创建", async () => {
		const h = makeHarness({ fresh: true, follow: "throw" });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.rtPatch).toHaveBeenCalledWith(SUB.id, expect.objectContaining({ followed: false }));
	});

	it("engines 未就绪(未登录/启动中)→ 不炸,订阅照建,不写关注状态", async () => {
		const h = makeHarness({ fresh: true, engines: "null" });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.follow).not.toHaveBeenCalled();
	});
});

/**
 * 拓展订阅(ADR-0019 决策 9 / 12 / 50)。
 *
 * GET 两支都回;关注状态只属于 B 站那支。新建拓展订阅要宿主核过「它是装着的订阅源」;已有的
 * 那条整份 POST 回来(面板的启用开关)照收,关注 / 单条资料刷新都不碰它。身份改不动,store 拒了就是 400。
 */
describe("/api/subscriptions × 拓展订阅", () => {
	beforeEach(() => vi.restoreAllMocks());

	const EXT = {
		id: "22222222-2222-4222-8222-222222222222",
		identity: { sourceKey: "douyin", externalId: "MS4wLjAB-sec" },
		enabled: true,
		tagIds: [],
		routing: {},
		extraTargets: { atAllPost: {}, atAllLiveStart: {}, wordcloud: {}, liveSummary: {} },
		overrides: {},
	};

	function postJson(h: Harness, body: unknown) {
		return h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("GET 两支都回:拓展订阅带资料缓存,不带关注状态", async () => {
		const h = makeHarness({
			subs: [SUB, EXT],
			rtRecord: {
				[SUB.id]: { followed: true },
				[EXT.id]: { cachedProfile: PROFILE, followed: true },
			},
		});
		const body = (await (await h.app.request("/")).json()) as Array<Record<string, unknown>>;
		expect(body.map((s) => s.id)).toEqual([SUB.id, EXT.id]);
		expect(body[0]?.followed).toBe(true);
		expect(body[1]?.cachedProfile).toEqual(PROFILE);
		expect("followed" in (body[1] ?? {})).toBe(false);
		expect("followError" in (body[1] ?? {})).toBe(false);
	});

	it("POST 一条新的拓展订阅,宿主没递装着的拓展名单 → 当作没装,404 not_found,不落盘", async () => {
		// 新建的完整路径(核订阅源、判重、种资料、存头像)见 subs-extension-create.test.ts。
		const h = makeHarness({ subs: [SUB] });
		const res = await postJson(
			h,
			makeExtensionSubscription({ id: EXT.id, extensionId: EXT.identity.sourceKey }),
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
		expect(h.upsertSubscription).not.toHaveBeenCalled();
	});

	it("POST 回一条已有的拓展订阅(启用开关)→ 照收,不关注、不拉资料", async () => {
		const h = makeHarness({ subs: [SUB, EXT] });
		const res = await postJson(h, { ...EXT, enabled: false });
		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.follow).not.toHaveBeenCalled();
		expect(h.refreshSubscription).not.toHaveBeenCalled();
		expect(h.rtPatch).not.toHaveBeenCalled();
	});

	it("新建拓展订阅时 store 拒收 → 也是按码回(400 invalid,逐格 issues 带上)", async () => {
		// 宿主先核的那几道(装着的订阅源、判重、资料)都过了,落盘那一步 store 又拒 —— 与别的写入同一个出口。
		const h = makeHarness({ subs: [SUB] });
		h.upsertSubscription.mockRejectedValueOnce(
			ConfigValidationError.invalid(
				"subscriptions",
				"订阅有 1 格不合法：identity.externalId：不能为空",
				[{ path: ["identity", "externalId"], message: "不能为空" }],
			),
		);
		const app = createSubscriptionsRoute(
			{
				store: {
					getSubscriptions: () => [SUB],
					upsertSubscription: h.upsertSubscription,
				},
				runtime: {
					serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
					subRuntimeStore: { get: () => undefined, patch: vi.fn() },
					sourceRegistry: { get: () => undefined },
					engines: null,
				},
			} as unknown as RouteDeps,
			{
				extensions: () => [
					{
						id: "douyin",
						dir: "/data/extensions/douyin",
						state: "running",
						manifest: {
							id: "douyin",
							name: "抖音订阅",
							description: "测试用",
							version: "0.1.0",
							apiVersion: 2,
							contributes: {
								subscription: {
									display: { label: "抖音", shortLabel: "抖", color: "#fe2c55" },
									events: ["post"],
								},
							},
						},
					},
				],
			},
		);
		const res = await app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(
				makeExtensionSubscription({ id: EXT.id, extensionId: "douyin", externalId: "sec-9" }),
			),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "invalid",
			message: "订阅有 1 格不合法：identity.externalId：不能为空",
			issues: [{ path: ["identity", "externalId"], message: "不能为空" }],
		});
	});

	it("store 拒了身份改动 → 400(PATCH 与 POST 同一个出口)", async () => {
		const identity = () =>
			ConfigValidationError.invalid(
				"subscriptions",
				"订阅的 identity.externalId 不能改（12345 → 999）",
				[{ path: ["identity", "externalId"], message: "身份格不许改" }],
			);
		const h = makeHarness();
		h.patchSubscription.mockRejectedValueOnce(identity());
		const patched = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ identity: { externalId: "999" } }),
		});
		expect(patched.status).toBe(400);
		expect(await patched.json()).toMatchObject({ code: "invalid" });
		h.upsertSubscription.mockRejectedValueOnce(identity());
		const posted = await postJson(h, {
			...SUB,
			identity: { ...SUB.identity, externalId: "999" },
		});
		expect(posted.status).toBe(400);
		expect(await posted.json()).toMatchObject({ code: "invalid" });
	});
});

describe("/api/subscriptions × 特别关注名单的观众 id(按来源描述符的格式核新加的)", () => {
	beforeEach(() => vi.restoreAllMocks());

	const json = { "content-type": "application/json" };
	const patch = (h: Harness, body: unknown) =>
		h.app.request(`/${SUB.id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
	const post = (h: Harness, body: unknown) =>
		h.app.request("/", { method: "POST", headers: json, body: JSON.stringify(body) });

	it("PATCH 加一个不合来源格式的观众 id → 400 invalid,issues 指到那一条,不进 store", async () => {
		const h = makeHarness();
		const res = await patch(h, {
			specialViewers: [
				{ id: "777", features: ["viewerChat"] },
				{ id: "not-a-uid", features: ["viewerEnter"] },
			],
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["specialViewers", 1, "id"] }],
		});
		expect(h.patchSubscription).not.toHaveBeenCalled();
	});

	it("PATCH 加合格式的观众 id → 放行", async () => {
		const h = makeHarness();
		const res = await patch(h, { specialViewers: [{ id: "777", features: ["viewerChat"] }] });
		expect(res.status).toBe(200);
		expect(h.patchSubscription).toHaveBeenCalledTimes(1);
	});

	it("名单上本来就有的老条目不回头核:迁移带来的不合格条目不挡着改别的格", async () => {
		const legacy = { id: "not-a-uid", features: ["viewerChat"] };
		const h = makeHarness({ subs: [{ ...SUB, specialViewers: [legacy] }] });
		const res = await patch(h, {
			specialViewers: [legacy, { id: "9", features: ["viewerEnter"] }],
		});
		expect(res.status).toBe(200);
		expect(h.patchSubscription).toHaveBeenCalledTimes(1);
	});

	it("POST 新建时名单里有不合格式的 id → 400,不 upsert", async () => {
		const h = makeHarness({ fresh: true });
		const res = await post(h, {
			...SUB,
			specialViewers: [{ id: "abc", features: ["viewerChat"] }],
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["specialViewers", 0, "id"] }],
		});
		expect(h.upsertSubscription).not.toHaveBeenCalled();
	});
});
