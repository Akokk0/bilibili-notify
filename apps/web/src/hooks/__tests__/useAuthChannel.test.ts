/**
 * 单元测试 — `handleAuthEnvelope` 纯函数(WS `auth` 频道事件分发)。
 *
 * 守护契约:
 *   - 非 auth 频道帧 silent-drop(防止跨 channel 误触发)
 *   - subscription-auth-changed → 按帧里的 sourceKey 把 state 写进 ["source-auth", sourceKey] 那一条缓存
 *     (账号留着),并让那一条失效重取;别的来源的缓存不动
 *   - 帧缺 data / 不识别的 event 不动缓存
 */

import type { SourceAuthResponse } from "@bilibili-notify/contract";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WsEnvelope } from "../../services/ws";
import { sourceAuthKey } from "../use-source-auth";
import { handleAuthEnvelope } from "../useAuthChannel";
import { eventFrameMaker } from "./ws-frames";

const TS = "2026-05-16T00:00:00.000Z";

/** 服务端发来的一帧合法事件帧:形状按 contract 的事件表写全,缺 `ts` 补上。 */
const env = eventFrameMaker(TS);

/** 故意违反类型的坏帧(`data` 缺格 / 类型不对、事件名不存在),测 hook 的防御。 */
const malformed = (frame: object) => ({ ts: TS, ...frame }) as WsEnvelope;

const LOGGED_IN = { status: "logged-in", loggedInAt: TS } as const;
const OTHER_KEY = "fake-source";

describe("handleAuthEnvelope — auth 频道事件分发", () => {
	let qc: QueryClient;
	let invalidate: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		qc = new QueryClient();
		const spy = vi.fn(qc.invalidateQueries.bind(qc));
		qc.invalidateQueries = spy;
		invalidate = spy;
	});

	const read = (sourceKey: string) => qc.getQueryData<SourceAuthResponse>(sourceAuthKey(sourceKey));

	it("非 auth 频道帧:不动缓存", () => {
		handleAuthEnvelope(
			env({ type: "log", event: "engine-error", data: { source: "x", message: "y" } }),
			qc,
		);
		expect(qc.getQueryCache().getAll()).toHaveLength(0);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("subscription-auth-changed:状态写进那个来源的缓存,账号留着,并让这一条失效", () => {
		qc.setQueryData<SourceAuthResponse>(sourceAuthKey("bilibili"), {
			state: { status: "logged-out" },
			account: { name: "晨风UP主" },
		});
		handleAuthEnvelope(
			env({
				type: "auth",
				event: "subscription-auth-changed",
				data: { sourceKey: "bilibili", state: LOGGED_IN },
			}),
			qc,
		);
		expect(read("bilibili")).toEqual({ state: LOGGED_IN, account: { name: "晨风UP主" } });
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: sourceAuthKey("bilibili") });
	});

	it("别的来源的帧:只写它自己那一条,B 站那条不动", () => {
		const before: SourceAuthResponse = { state: { status: "logged-out" } };
		qc.setQueryData<SourceAuthResponse>(sourceAuthKey("bilibili"), before);
		handleAuthEnvelope(
			env({
				type: "auth",
				event: "subscription-auth-changed",
				data: {
					sourceKey: OTHER_KEY,
					state: { status: "error", message: "二维码已超时（3分钟），请重新登录" },
				},
			}),
			qc,
		);
		expect(read("bilibili")).toBe(before);
		expect(read(OTHER_KEY)?.state).toEqual({
			status: "error",
			message: "二维码已超时（3分钟），请重新登录",
		});
		expect(invalidate).toHaveBeenCalledWith({ queryKey: sourceAuthKey(OTHER_KEY) });
	});

	it("subscription-auth-changed 但 data 缺失:不动缓存(防御性)", () => {
		handleAuthEnvelope(malformed({ type: "auth", event: "subscription-auth-changed" }), qc);
		expect(qc.getQueryCache().getAll()).toHaveLength(0);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("不识别的 event(含不再处理的 auth-lost):不动缓存", () => {
		handleAuthEnvelope(malformed({ type: "auth", event: "auth-lost", data: null }), qc);
		handleAuthEnvelope(malformed({ type: "auth", event: "subscribed" }), qc);
		expect(qc.getQueryCache().getAll()).toHaveLength(0);
		expect(invalidate).not.toHaveBeenCalled();
	});
});
