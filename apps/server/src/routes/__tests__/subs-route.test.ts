/**
 * 单元测试 — /api/subs 的「外置 runtime 字段回 join」+「POST 自 seed cachedProfile」。
 *
 * cachedProfile / state 已从 Subscription 外置(M2)。DTO 必须把:
 *  - cachedProfile 从 SubRuntimeStore join 回(有才带,无则 undefined);
 *  - state 填一个常量({lastPushedAt:{},liveStatus:"unknown"})满足 apps/web 非可选
 *    state 类型 + Rules.tsx 恒 "unknown" 读,而不凭空造数据。
 * POST 创建后服务端自 seed:engines 就绪且该 sub 尚无 cachedProfile 时,调
 * getUserCardInfo 拉一次写进 SubRuntimeStore;失败 best-effort 不致命;engines
 * 为 null 时跳过。GET/POST/PATCH 响应都走同一 toDTO,保证前端缓存一致。
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConfigValidationError } from "../../config/store.js";
import { createSubsRoute } from "../subs.js";
import type { RouteDeps } from "../types.js";

const SUB = {
	id: "11111111-1111-1111-1111-111111111111",
	uid: "12345",
	enabled: true,
	groups: [],
	routing: {},
	atAllDefaults: { dynamic: false, live: true },
	atAll: { dynamic: {}, live: {} },
	overrides: {},
	specialUsers: [],
};

const PROFILE = {
	name: "测试UP",
	avatar: "https://example.com/a.png",
	sign: "签名",
	fans: 1234,
	lastRefreshedAt: "2026-05-19T00:00:00.000Z",
};

interface Harness {
	app: ReturnType<typeof createSubsRoute>;
	getSubscriptions: ReturnType<typeof vi.fn>;
	upsertSubscription: ReturnType<typeof vi.fn>;
	patchSubscription: ReturnType<typeof vi.fn>;
	rtGet: ReturnType<typeof vi.fn>;
	rtPatch: ReturnType<typeof vi.fn>;
	getUserCardInfo: ReturnType<typeof vi.fn>;
	follow: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: {
	subs?: unknown[];
	rtRecord?: Record<string, unknown>;
	engines?: "ok" | "null" | "throw" | "code-fail";
	/** follow() 的结果:ok=已关注成功;already=22014 已关注过;fail=业务码失败;throw=网络炸。 */
	follow?: "ok" | "already" | "fail" | "throw";
}): Harness {
	const subs = opts?.subs ?? [SUB];
	const rtRecord = opts?.rtRecord ?? {};
	const enginesMode = opts?.engines ?? "ok";

	const getSubscriptions = vi.fn(() => subs);
	const upsertSubscription = vi.fn(async () => {});
	const patchSubscription = vi.fn(async (_id: string, _patch: unknown) => SUB);
	const rtGet = vi.fn((id: string) => rtRecord[id]);
	const rtPatch = vi.fn(async () => {});

	const getUserCardInfo = vi.fn(async (_uid: string) => {
		if (enginesMode === "throw") throw new Error("network down");
		if (enginesMode === "code-fail") return { code: -404, data: null };
		return {
			code: 0,
			data: {
				card: {
					mid: SUB.uid,
					name: PROFILE.name,
					face: PROFILE.avatar,
					sign: PROFILE.sign,
					fans: PROFILE.fans,
				},
			},
		};
	});

	const followMode = opts?.follow ?? "ok";
	const follow = vi.fn(async (_fid: string) => {
		if (followMode === "throw") throw new Error("network down");
		if (followMode === "already") return { code: 22014, message: "已关注" };
		if (followMode === "fail") return { code: 22003, message: "对方已将你拉黑" };
		return { code: 0, message: "0" };
	});

	const engines = enginesMode === "null" ? null : { api: { getUserCardInfo, follow } };

	const deps = {
		store: { getSubscriptions, upsertSubscription, patchSubscription },
		runtime: {
			serviceCtx: { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
			subRuntimeStore: { get: rtGet, patch: rtPatch },
			engines,
		},
	} as unknown as RouteDeps;

	return {
		app: createSubsRoute(deps),
		getSubscriptions,
		upsertSubscription,
		patchSubscription,
		rtGet,
		rtPatch,
		getUserCardInfo,
		follow,
	};
}

describe("/api/subs GET — runtime 字段 join", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("无 cachedProfile 时返回 undefined,但 state 常量恒在", async () => {
		const h = makeHarness();
		const res = await h.app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect(body).toHaveLength(1);
		const row = body[0] as Record<string, unknown>;
		expect(row.cachedProfile).toBeUndefined();
		expect(row.state).toEqual({ lastPushedAt: {}, liveStatus: "unknown" });
		// 配置字段透传
		expect(row.id).toBe(SUB.id);
		expect(row.uid).toBe(SUB.uid);
	});

	it("有 cachedProfile 时 join 回 DTO(fansBaseline 永不外泄)", async () => {
		const h = makeHarness({
			rtRecord: {
				[SUB.id]: {
					cachedProfile: PROFILE,
					fansBaseline: { value: 1000, ts: "2026-04-01T00:00:00.000Z" },
				},
			},
		});
		const res = await h.app.request("/");
		const body = (await res.json()) as Array<Record<string, unknown>>;
		const row = body[0] as Record<string, unknown>;
		expect(row.cachedProfile).toEqual(PROFILE);
		// fansBaseline 是 FansPoller 私有,绝不进 DTO
		expect("fansBaseline" in row).toBe(false);
		expect(row.state).toEqual({ lastPushedAt: {}, liveStatus: "unknown" });
	});

	it("Rules.tsx 的 sub.state.liveStatus 读取不会抛(常量永远是 'unknown')", async () => {
		const h = makeHarness();
		const res = await h.app.request("/");
		const body = (await res.json()) as Array<{ state: { liveStatus: string } }>;
		const row = body[0] as { state: { liveStatus: string } };
		expect(row.state.liveStatus).toBe("unknown");
		// 等同 Rules.tsx:236 `sub.state.liveStatus === "live"` —— 不抛,得 false
		expect(row.state.liveStatus === "live").toBe(false);
	});
});

/**
 * SubRuntimeStore.patch 里**属于 seed 的**那些调用。
 *
 * POST 现在会写两类 runtime 状态:关注结果(followed/followError)与 cachedProfile。
 * 下面这组用例只关心后者,所以按内容筛,而不是数 patch 被调了几次 —— 数次数会让它们
 * 跟「POST 还顺手做了什么」耦死,以后再加一类 runtime 写入又得全改一遍。
 */
function seedCalls(h: Harness) {
	return h.rtPatch.mock.calls.filter(
		([, patch]) => typeof patch === "object" && patch !== null && "cachedProfile" in patch,
	);
}

describe("/api/subs POST — 创建后服务端自 seed cachedProfile", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("新 sub 且 engines 就绪 → 调 getUserCardInfo 并 patch 进 SubRuntimeStore", async () => {
		const h = makeHarness({ rtRecord: {} });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.getUserCardInfo).toHaveBeenCalledWith(SUB.uid);
		const seeds = seedCalls(h);
		expect(seeds).toHaveLength(1);
		const [id, patch] = seeds[0] as [string, { cachedProfile: typeof PROFILE }];
		expect(id).toBe(SUB.id);
		expect(patch.cachedProfile).toMatchObject({
			name: PROFILE.name,
			avatar: PROFILE.avatar,
			sign: PROFILE.sign,
			fans: PROFILE.fans,
		});
		expect(typeof patch.cachedProfile.lastRefreshedAt).toBe("string");
		// 响应也走 toDTO(数组 + state 常量)
		const body = (await res.json()) as Array<Record<string, unknown>>;
		expect((body[0] as Record<string, unknown>).state).toEqual({
			lastPushedAt: {},
			liveStatus: "unknown",
		});
	});

	it("已有 cachedProfile → 跳过 seed(bounded,不重复打 B 站)", async () => {
		const h = makeHarness({ rtRecord: { [SUB.id]: { cachedProfile: PROFILE } } });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(h.getUserCardInfo).not.toHaveBeenCalled();
		expect(seedCalls(h)).toHaveLength(0);
	});

	it("engines 为 null → 跳过 seed,不致命(200)", async () => {
		const h = makeHarness({ engines: "null" });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(seedCalls(h)).toHaveLength(0);
	});

	it("getUserCardInfo 抛错 → best-effort,POST 仍 200", async () => {
		const h = makeHarness({ engines: "throw" });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(seedCalls(h)).toHaveLength(0);
	});

	it("getUserCardInfo 返回 code!=0 → 不 patch,POST 仍 200", async () => {
		const h = makeHarness({ engines: "code-fail" });
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(SUB),
		});
		expect(res.status).toBe(200);
		expect(seedCalls(h)).toHaveLength(0);
	});

	it("无效 JSON body → 400,不 upsert", async () => {
		const h = makeHarness();
		const res = await h.app.request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		expect(h.upsertSubscription).not.toHaveBeenCalled();
	});
});

describe("/api/subs PATCH — 响应同样 join", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("PATCH 返回单条 joined DTO(cachedProfile + state 常量)", async () => {
		const h = makeHarness({ rtRecord: { [SUB.id]: { cachedProfile: PROFILE } } });
		const res = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.cachedProfile).toEqual(PROFILE);
		expect(body.state).toEqual({ lastPushedAt: {}, liveStatus: "unknown" });
		expect(h.patchSubscription).toHaveBeenCalledWith(SUB.id, { enabled: false });
	});

	it("patchSubscription 抛 ConfigValidationError(not found)→ 404", async () => {
		const h = makeHarness();
		// isNotFound() 读 err.issues.message(把 issues 当对象,非数组),
		// 见 subs.ts:236-239 —— 这里照其契约构造。
		h.patchSubscription.mockRejectedValueOnce(
			new ConfigValidationError("subscriptions", { message: "subscription not found" }),
		);
		const res = await h.app.request(`/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(404);
	});
});

/**
 * POST 自动关注该 UP。
 *
 * 动态是从 `feed/all`(**关注流**)拉的 —— 只会返回你已关注的人的动态。所以订阅一个
 * UP 却不去关注他,等于订阅了个寂寞:配置里有这条记录,动态流里永远没有他,一条都推
 * 不出来。koishi 端一直在 subscription-loader 里 follow,独立端**从来没做过**。
 */
describe("/api/subs POST — 自动关注该 UP", () => {
	beforeEach(() => vi.restoreAllMocks());

	async function post(h: Harness, body: unknown = SUB) {
		return h.app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("新增订阅 → 去 B 站关注该 UP(否则 feed/all 里根本没有他的动态)", async () => {
		const h = makeHarness();
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.follow).toHaveBeenCalledWith(SUB.uid);
	});

	it("已经关注过(22014) → 视为成功,不当失败报", async () => {
		const h = makeHarness({ follow: "already" });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.rtPatch).toHaveBeenCalledWith(SUB.id, expect.objectContaining({ followed: true }));
	});

	it("关注失败 → 订阅照建,但把「未关注」如实记下(别让用户以为好了)", async () => {
		const h = makeHarness({ follow: "fail" });
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
		const h = makeHarness({ follow: "throw" });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.rtPatch).toHaveBeenCalledWith(SUB.id, expect.objectContaining({ followed: false }));
	});

	it("engines 未就绪(未登录/启动中)→ 不炸,订阅照建,不写关注状态", async () => {
		const h = makeHarness({ engines: "null" });
		const res = await post(h);

		expect(res.status).toBe(200);
		expect(h.upsertSubscription).toHaveBeenCalledTimes(1);
		expect(h.follow).not.toHaveBeenCalled();
	});
});
