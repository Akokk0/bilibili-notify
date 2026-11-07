/**
 * per-UP 定时锐评的审批闸。
 *
 * 与全局那条(`checkApprovalEnable`)守的是**同一个死局**:在一个收不到回复的通道
 * 上开审批,每期都生成、私聊、48 小时后作废,一份也发不出去,而配置页看着一切正常。
 *
 * 全局那侧有闸、per-UP 没有的话,主人只要换个地方开同一个开关就绕过去了 ——
 * 一道只拦一半的闸比没有更糟,因为它让人以为拦住了。
 *
 * 能不能收到主人的回复问的是主人目标所挂那条连接的 `inbound` 能力(适配器的回答):
 * 支持才能开;不支持带原因拦下;还不知道也拦下,并说清是「还不知道」。
 */

import type { ConnectionCapabilities } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { checkApprovalReachable } from "../roast-approval-guard.js";
import { createSubscriptionsRoute } from "../subscriptions.js";
import type { RouteDeps } from "../types.js";

// 目标自己没有平台这一格 —— 它挂在连接 c1 上,能力问 c1。
const TARGETS = [{ id: "m1", connectionId: "c1" }] as never;
const CONNECTIONS = [{ id: "c1" }] as never;

const UNKNOWN = { state: "unknown" } as const;

/** 能力表:连接 c1 的 inbound 是给定的那一格;别的连接没有能力。 */
function inboundOf(inbound: ConnectionCapabilities["inbound"]) {
	return (id: string): ConnectionCapabilities | undefined =>
		id === "c1" ? { atAll: UNKNOWN, inbound, nativeShare: UNKNOWN } : undefined;
}
const RECEIVES = inboundOf({ state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" });
const NO_RETURN_PATH = inboundOf({
	state: "unsupported",
	reason: "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话",
	checkedAt: "2026-10-26T00:00:00.000Z",
});
const NOT_KNOWN = inboundOf({ state: "unknown", reason: "桥没报这一项" });
const NOT_KNOWN_NO_REASON = inboundOf({ state: "unknown" });

describe("checkApprovalReachable", () => {
	it("审批没开 → 不插手(别拿一道无关的闸拦住别的保存)", () => {
		expect(
			checkApprovalReachable({
				approvalOn: false,
				masterTargetId: "",
				targets: [],
				connections: [],
				capabilitiesOf: NO_RETURN_PATH,
			}).ok,
		).toBe(true);
	});

	it("主人私聊那条连接的 inbound 是「支持」→ 放行", () => {
		expect(
			checkApprovalReachable({
				approvalOn: true,
				masterTargetId: "m1",
				targets: TARGETS,
				connections: CONNECTIONS,
				capabilitiesOf: RECEIVES,
			}).ok,
		).toBe(true);
	});

	it("没配主人私聊目标 → 拦下(没人可审)", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: undefined,
			targets: [],
			connections: [],
			capabilitiesOf: RECEIVES,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(r.ok === false && r.message).toContain("主人私聊目标");
	});

	it("配的目标已经不存在 → 拦下并说清楚", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: "gone",
			targets: TARGETS,
			connections: CONNECTIONS,
			capabilitiesOf: RECEIVES,
		});
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("不存在");
	});

	it("inbound 是「不支持」→ 拦下,话里带能力给的原因,并指路(换连接 / 关审批)", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: "m1",
			targets: TARGETS,
			connections: CONNECTIONS,
			capabilitiesOf: NO_RETURN_PATH,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(r.ok === false && r.message).toBe(
			"审批打不开：webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话。请把主人私聊目标换成收得到回复的连接，或者把审批关掉。",
		);
	});

	it("inbound 是「还不知道」→ 拦下,话里说「还不知道」并带上原因", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: "m1",
			targets: TARGETS,
			connections: CONNECTIONS,
			capabilitiesOf: NOT_KNOWN,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(r.ok === false && r.message).toBe(
			"审批打不开：还不知道这条连接收不收得到主人的回复（桥没报这一项）。请把主人私聊目标换成收得到回复的连接，或者把审批关掉。",
		);
	});

	it("inbound 是「还不知道」且没有原因 → 话里没有括号", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: "m1",
			targets: TARGETS,
			connections: CONNECTIONS,
			capabilitiesOf: NOT_KNOWN_NO_REASON,
		});
		expect(r.ok === false && r.message).toContain("还不知道这条连接收不收得到主人的回复。");
		expect(r.ok === false && r.message).not.toContain("（");
	});

	it("取不到这条连接的能力(引擎还没起来)→ 按还不知道算,拦下", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: "m1",
			targets: TARGETS,
			connections: CONNECTIONS,
			capabilitiesOf: () => undefined,
		});
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(r.ok === false && r.message).toContain("还不知道");
	});

	it("主人目标挂的那条连接已经不在了 → not_configured,说清是连接没了", () => {
		const r = checkApprovalReachable({
			approvalOn: true,
			masterTargetId: "m1",
			targets: TARGETS,
			connections: [],
			capabilitiesOf: RECEIVES,
		});
		expect(r).toMatchObject({
			ok: false,
			code: "not_configured",
			message: "审批打不开：主人私聊目标挂的那条连接已经不在了，请先重新指定。",
		});
	});

	it("能力取自目标所挂的连接,不看目标自己那一格", () => {
		// 目标上写着别的平台也没用:能力只问它挂着的连接 c1。
		const stale = [{ id: "m1", connectionId: "c1", platform: "onebot" }] as never;
		expect(
			checkApprovalReachable({
				approvalOn: true,
				masterTargetId: "m1",
				targets: stale,
				connections: CONNECTIONS,
				capabilitiesOf: NO_RETURN_PATH,
			}).ok,
		).toBe(false);
		const stale2 = [{ id: "m1", connectionId: "c1", platform: "feishu" }] as never;
		expect(
			checkApprovalReachable({
				approvalOn: true,
				masterTargetId: "m1",
				targets: stale2,
				connections: CONNECTIONS,
				capabilitiesOf: RECEIVES,
			}).ok,
		).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

/**
 * 走完整 PATCH 路径 —— 光有纯函数不算数,得确认路由真的问过它。
 * `inbound` 是主人目标那条连接 c1 的 inbound 能力,经 `pipeline.connectionCapabilities` 取;
 * `null` = 没配主人目标;`pipeline: false` = 引擎还没起来。
 */
function routeWith(
	inbound: ConnectionCapabilities["inbound"] | null,
	opts: { pipeline?: boolean } = {},
) {
	// 放行时路由要把改完的订阅回成 视图,所以替身得回一条有身份的订阅,不能是 `{}`。
	const patchSubscription = vi.fn(async () => ({
		id: "s1",
		identity: { sourceKey: "bilibili", externalId: "1" },
	}));
	const deps = {
		store: {
			getSubscriptions: () => [
				{
					id: "s1",
					identity: { sourceKey: "bilibili", externalId: "1" },
					roastSchedule: { approval: false, enabled: false },
				},
				// 拓展订阅也有单人定时锐评(ADR-0020 决策 14),审批已经开着。
				{
					id: "e1",
					identity: { sourceKey: "douyin", externalId: "sec-1" },
					roastSchedule: { approval: true, enabled: true },
				},
			],
			getGlobals: () => ({ master: { targetId: inbound ? "m1" : undefined } }),
			getTargets: () => (inbound ? [{ id: "m1", connectionId: "c1" }] : []),
			getConnections: () => (inbound ? [{ id: "c1" }] : []),
			patchSubscription,
		},
		runtime: {
			serviceCtx: { logger: { warn() {}, error() {}, info() {}, debug() {} } },
			subscriptionStateStore: { get: () => undefined },
			problems: { list: () => [] },
			pipeline:
				opts.pipeline === false || !inbound ? null : { connectionCapabilities: inboundOf(inbound) },
		},
	} as unknown as RouteDeps;
	return { app: createSubscriptionsRoute(deps, {}), patchSubscription };
}

const SUPPORTED = { state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" } as const;
const UNSUPPORTED = {
	state: "unsupported",
	reason: "没有回程",
	checkedAt: "2026-10-26T00:00:00.000Z",
} as const;

const patchRoast = (body: unknown) => ({
	method: "PATCH",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

describe("PATCH /api/subscriptions/:id — per-UP 审批闸", () => {
	it("在收不到回复的通道上开审批 → 409 not_configured,而且**没落盘**", async () => {
		const { app, patchSubscription } = routeWith(UNSUPPORTED);
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { approval: true } }) as RequestInit,
		);
		// 要主人去把私聊目标换成收得到回复的通道 —— 等是等不好的,所以是 not_configured(409)。
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "not_configured", message: expect.any(String) });
		// 拦下就得真拦住 —— 回了错却已经写进去,是最坏的一种「拦截」。
		expect(patchSubscription).not.toHaveBeenCalled();
	});

	it("通道收得到 → 放行", async () => {
		const { app, patchSubscription } = routeWith(SUPPORTED);
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { approval: true } }) as RequestInit,
		);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});

	it("引擎还没起来(取不到能力)→ 按还不知道算,409 拦下", async () => {
		const { app, patchSubscription } = routeWith(SUPPORTED, { pipeline: false });
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { approval: true } }) as RequestInit,
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ message: expect.stringContaining("还不知道") });
		expect(patchSubscription).not.toHaveBeenCalled();
	});

	it("这次 patch 不碰 roastSchedule → 闸不插手(别拦住改别的字段)", async () => {
		const { app, patchSubscription } = routeWith(UNSUPPORTED);
		const res = await app.request("/s1", patchRoast({ enabled: false }) as RequestInit);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});

	it("只改 cron、审批本来就关着 → 放行", async () => {
		const { app, patchSubscription } = routeWith(UNSUPPORTED);
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { cron: "0 9 * * 1" } }) as RequestInit,
		);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});
});

describe("PATCH /api/subscriptions/:id — 拓展订阅同一道闸(ADR-0020 决策 14)", () => {
	it("在收不到回复的通道上给拓展订阅开审批 → 409 not_configured,没落盘", async () => {
		const { app, patchSubscription } = routeWith(UNSUPPORTED);
		const res = await app.request(
			"/e1",
			patchRoast({ roastSchedule: { approval: true } }) as RequestInit,
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "not_configured" });
		expect(patchSubscription).not.toHaveBeenCalled();
	});

	it("审批本来就开着、这次只改 cron → 照样过闸:收不到回复的通道上拦下", async () => {
		// 闸看的是「存完之后审批开没开」:这次没带 approval 就看它现在的值 —— 拓展订阅也得读它自己那一格,
		// 不能当成「拓展没有锐评、审批恒关」放过去。
		const { app, patchSubscription } = routeWith(UNSUPPORTED);
		const res = await app.request(
			"/e1",
			patchRoast({ roastSchedule: { cron: "0 9 * * 1" } }) as RequestInit,
		);
		expect(res.status).toBe(409);
		expect(patchSubscription).not.toHaveBeenCalled();
	});

	it("通道收得到 → 放行", async () => {
		const { app, patchSubscription } = routeWith(SUPPORTED);
		const res = await app.request(
			"/e1",
			patchRoast({ roastSchedule: { cron: "0 9 * * 1" } }) as RequestInit,
		);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});
});
