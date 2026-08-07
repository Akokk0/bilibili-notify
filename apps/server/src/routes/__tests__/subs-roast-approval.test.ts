/**
 * per-UP 定时锐评的审批闸。
 *
 * 与全局那条(`checkApprovalEnable`)守的是**同一个死局**:在一个收不到回复的通道
 * 上开审批,每期都生成、私聊、48 小时后作废,一份也发不出去,而配置页看着一切正常。
 *
 * 全局那侧有闸、per-UP 没有的话,主人只要换个地方开同一个开关就绕过去了 ——
 * 一道只拦一半的闸比没有更糟,因为它让人以为拦住了。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { checkApprovalReachable } from "../roast-approval-guard.js";
import { createSubsRoute } from "../subs.js";
import type { RouteDeps } from "../types.js";

const ONEBOT = [{ id: "m1", platform: "onebot" }] as never;
const WEBHOOK = [{ id: "m1", platform: "webhook" }] as never;

describe("checkApprovalReachable", () => {
	it("审批没开 → 不插手(别拿一道无关的闸拦住别的保存)", () => {
		expect(checkApprovalReachable({ approvalOn: false, masterTargetId: "", targets: [] }).ok).toBe(
			true,
		);
	});

	it("主人私聊走 onebot → 放行", () => {
		expect(
			checkApprovalReachable({ approvalOn: true, masterTargetId: "m1", targets: ONEBOT }).ok,
		).toBe(true);
	});

	it("没配主人私聊目标 → 拦下(没人可审)", () => {
		const r = checkApprovalReachable({ approvalOn: true, masterTargetId: undefined, targets: [] });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("主人私聊目标");
	});

	it("配的目标已经不存在 → 拦下并说清楚", () => {
		const r = checkApprovalReachable({ approvalOn: true, masterTargetId: "gone", targets: ONEBOT });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("不存在");
	});

	it("通道收不到回复 → 拦下,理由与可选平台都从常量出", () => {
		const r = checkApprovalReachable({ approvalOn: true, masterTargetId: "m1", targets: WEBHOOK });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toContain("回程");
		// 「那我该换成什么」得答得上来。
		expect(r.ok === false && r.message).toContain("onebot");
	});
});

/* -------------------------------------------------------------------------- */

/** 走完整 PATCH 路径 —— 光有纯函数不算数,得确认路由真的问过它。 */
function routeWith(masterPlatform: string | null) {
	const patchSubscription = vi.fn(async () => ({}));
	const deps = {
		store: {
			getSubscriptions: () => [
				{ id: "s1", uid: "1", roastSchedule: { approval: false, enabled: false } },
			],
			getGlobals: () => ({ master: { targetId: masterPlatform ? "m1" : undefined } }),
			getTargets: () => (masterPlatform ? [{ id: "m1", platform: masterPlatform }] : []),
			patchSubscription,
		},
		runtime: {
			serviceCtx: { logger: { warn() {}, error() {}, info() {}, debug() {} } },
			subRuntimeStore: { get: () => undefined },
			engines: null,
		},
	} as unknown as RouteDeps;
	return { app: createSubsRoute(deps), patchSubscription };
}

const patchRoast = (body: unknown) => ({
	method: "PATCH",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

describe("PATCH /api/subs/:id — per-UP 审批闸", () => {
	it("在收不到回复的通道上开审批 → 400,而且**没落盘**", async () => {
		const { app, patchSubscription } = routeWith("webhook");
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { approval: true } }) as RequestInit,
		);
		expect(res.status).toBe(400);
		// 拦下就得真拦住 —— 回了 400 却已经写进去,是最坏的一种「拦截」。
		expect(patchSubscription).not.toHaveBeenCalled();
	});

	it("通道收得到 → 放行", async () => {
		const { app, patchSubscription } = routeWith("onebot");
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { approval: true } }) as RequestInit,
		);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});

	it("这次 patch 不碰 roastSchedule → 闸不插手(别拦住改别的字段)", async () => {
		const { app, patchSubscription } = routeWith("webhook");
		const res = await app.request("/s1", patchRoast({ enabled: false }) as RequestInit);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});

	it("只改 cron、审批本来就关着 → 放行", async () => {
		const { app, patchSubscription } = routeWith("webhook");
		const res = await app.request(
			"/s1",
			patchRoast({ roastSchedule: { cron: "0 9 * * 1" } }) as RequestInit,
		);
		expect(res.status).toBe(200);
		expect(patchSubscription).toHaveBeenCalledTimes(1);
	});
});
