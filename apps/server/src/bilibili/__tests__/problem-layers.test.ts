/**
 * B 站分层上报器:B 站的报错按因果分三层,同时只在表里留最上面一层 ——
 *   未登录(`auth_lost`,看 `AuthState.status`)> 风控(`risk_controlled`)> 各项请求失败(调用方给 code)。
 *
 * 上报器手里存的是「此刻该在表里的东西」,不是事件流水;接上核心(`attach`)那一刻把它整份报上去,
 * 接上之前记着的因此不会丢。每个方法都不许往外抛:调用点都在引擎的关键控制流上。
 */

import type { AuthState, Disposable, SourceAuth } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeLogger } from "../../subscriptions/__tests__/fixtures.js";
import { createProblemLayers, type ProblemLayers } from "../problem-layers.js";
import { PROBLEM_TEXTS } from "../problem-texts.js";

const SCAN: AuthState = {
	status: "awaiting-scan",
	qr: { dataUrl: "data:image/png;base64,QR", expiresAt: "2026-10-11T00:03:00.000Z" },
};
const IN: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
const OUT: AuthState = { status: "logged-out" };
const EXPIRED: AuthState = { status: "expired", message: "失效" };
const CONFIRMING: AuthState = { status: "confirming", message: "确认中" };
const ERROR: AuthState = { status: "error", message: "超时" };

/** 假登录口:状态由测试拨,`onChange` 的订阅者记着。 */
function makeAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<() => void>();
	const unsubscribed = vi.fn();
	const auth: Pick<SourceAuth, "state" | "onChange"> = {
		state: () => state,
		onChange: (fn): Disposable => {
			listeners.add(fn);
			return {
				dispose() {
					unsubscribed();
					listeners.delete(fn);
				},
			};
		},
	};
	return {
		auth,
		unsubscribed,
		listeners,
		/** 状态变了:换值再叫一声。 */
		set(next: AuthState) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
	};
}

/** 记录用的核心那头。 */
function makeSink() {
	return {
		reportProblem: vi.fn<(p: Parameters<ProblemSink["reportProblem"]>[0]) => void>(),
		resolveProblem: vi.fn<(p: Parameters<ProblemSink["resolveProblem"]>[0]) => void>(),
	};
}
type ProblemSink = Parameters<ProblemLayers["attach"]>[0];

function setup(initial: AuthState = IN, attached = true) {
	const fake = makeAuth(initial);
	const layers = createProblemLayers({ auth: fake.auth, logger: makeLogger() });
	const sink = makeSink();
	if (attached) layers.attach(sink);
	return { ...fake, layers, sink };
}

const LOGIN = { code: "auth_lost" };
const RISK = { code: "risk_controlled" };

describe("未登录层:只看 AuthState.status", () => {
	it("开机 expired:attach 时报一条 auth_lost,来源级、带私聊", () => {
		const { sink } = setup(EXPIRED);
		expect(sink.reportProblem).toHaveBeenCalledTimes(1);
		expect(sink.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginExpired,
			notify: true,
		});
	});

	it("开机 logged-out(没登录过 / 主动退出):报一条 auth_lost,不带私聊,话是「还没有登录」", () => {
		const { sink } = setup(OUT);
		expect(sink.reportProblem).toHaveBeenCalledTimes(1);
		expect(sink.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginMissing,
			notify: false,
		});
	});

	it("开机已登录:什么都不报", () => {
		const { sink } = setup(IN);
		expect(sink.reportProblem).not.toHaveBeenCalled();
	});

	it("运行中掉登录(logged-in → expired):当场报,带私聊", () => {
		const { sink, set } = setup(IN);
		set(EXPIRED);
		expect(sink.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginExpired,
			notify: true,
		});
	});

	it("logged-in 清掉它,走普通的清(照常补「已恢复」,不带 notify)", () => {
		const { sink, set } = setup(EXPIRED);
		set(IN);
		expect(sink.resolveProblem).toHaveBeenCalledTimes(1);
		expect(sink.resolveProblem).toHaveBeenCalledWith(LOGIN);
	});

	it("已登录时重扫 → 超时(awaiting-scan / confirming / error):一条都不开", () => {
		const { sink, set } = setup(IN);
		for (const s of [SCAN, CONFIRMING, ERROR]) set(s);
		expect(sink.reportProblem).not.toHaveBeenCalled();
		expect(sink.resolveProblem).not.toHaveBeenCalled();
	});

	it("未登录时扫码途中(awaiting-scan / confirming / error)不清它,保持上一次的结论", () => {
		const { sink, set } = setup(EXPIRED);
		for (const s of [SCAN, CONFIRMING, ERROR]) set(s);
		expect(sink.resolveProblem).not.toHaveBeenCalled();
		set(IN);
		expect(sink.resolveProblem).toHaveBeenCalledTimes(1);
	});

	it("开机 confirming(还没向 B 站确认):不开;之后探到失效才开", () => {
		const { sink, set } = setup(CONFIRMING);
		expect(sink.reportProblem).not.toHaveBeenCalled();
		set(EXPIRED);
		expect(sink.reportProblem).toHaveBeenCalledTimes(1);
	});

	it("失效后主动退出(expired → logged-out):换成不带私聊的那一句,不先清再开", () => {
		const { sink, set } = setup(EXPIRED);
		sink.reportProblem.mockClear();
		set(OUT);
		expect(sink.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginMissing,
			notify: false,
		});
		expect(sink.resolveProblem).not.toHaveBeenCalled();
	});
});

describe("压与抹", () => {
	it("未登录一开:手里的风控路在表里静默抹掉(notify: false),再报未登录", () => {
		const { sink, set, layers } = setup(IN);
		layers.reportRisk("dynamic");
		layers.reportRisk("live:1");
		sink.resolveProblem.mockClear();
		sink.reportProblem.mockClear();

		set(EXPIRED);

		expect(sink.resolveProblem.mock.calls.map(([p]) => p)).toEqual([{ ...RISK, notify: false }]);
		expect(sink.reportProblem).toHaveBeenCalledTimes(1);
		expect(sink.reportProblem.mock.calls[0]?.[0].code).toBe("auth_lost");
		// 风控路清空了:之后这些路的「清」不再引出任何一次核心调用
		layers.resolveRisk("dynamic");
		expect(sink.resolveProblem).toHaveBeenCalledTimes(1);
	});

	it("未登录一开:手里的第三层失败也静默抹掉", () => {
		const { sink, set, layers } = setup(IN);
		layers.reportFailure({ externalId: "7", code: "live_monitor_stopped", message: "停了" });
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		sink.resolveProblem.mockClear();

		set(EXPIRED);

		expect(sink.resolveProblem.mock.calls.map(([p]) => p)).toEqual([
			{ externalId: "7", code: "live_monitor_stopped", notify: false },
			{ code: "dynamic_fetch_failed", notify: false },
		]);
	});

	it("未登录开着时:风控与失败只记日志,不进表", () => {
		const { sink, layers } = setup(EXPIRED);
		sink.reportProblem.mockClear();
		layers.reportRisk("dynamic");
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		expect(sink.reportProblem).not.toHaveBeenCalled();
	});

	it("未登录开着时存的东西不许等它清掉后自己冒出来:清掉再重新接上,表里只有现状(空)", () => {
		const { sink, set, layers } = setup(EXPIRED);
		layers.reportRisk("dynamic");
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		set(IN);
		layers.detach();
		sink.reportProblem.mockClear();
		layers.attach(sink);
		expect(sink.reportProblem).not.toHaveBeenCalled();
	});

	it("风控一开:第三层全清空并静默抹掉,再报风控(带私聊)", () => {
		const { sink, layers } = setup(IN);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		layers.reportFailure({ externalId: "7", code: "live_monitor_stopped", message: "y" });
		sink.reportProblem.mockClear();
		sink.resolveProblem.mockClear();

		layers.reportRisk("dynamic");

		expect(sink.resolveProblem).toHaveBeenCalledTimes(2);
		expect(sink.resolveProblem.mock.calls.every(([p]) => p.notify === false)).toBe(true);
		expect(sink.reportProblem).toHaveBeenCalledWith({
			code: "risk_controlled",
			message: PROBLEM_TEXTS.riskControlled,
			notify: true,
		});
	});

	it("风控开着时失败只记日志,不进表;风控清掉后它也不自己冒回来", () => {
		const { sink, layers } = setup(IN);
		layers.reportRisk("dynamic");
		sink.reportProblem.mockClear();
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		expect(sink.reportProblem).not.toHaveBeenCalled();
		layers.resolveRisk("dynamic");
		expect(sink.reportProblem).not.toHaveBeenCalled();
	});

	it("两路风控各清各的,最后一路清了才清表(普通的清);同一路重复撞只报一次", () => {
		const { sink, layers } = setup(IN);
		layers.reportRisk("dynamic");
		layers.reportRisk("dynamic");
		layers.reportRisk("live:1");
		expect(sink.reportProblem).toHaveBeenCalledTimes(1);

		layers.resolveRisk("dynamic");
		expect(sink.resolveProblem).not.toHaveBeenCalled();
		layers.resolveRisk("live:1");
		expect(sink.resolveProblem).toHaveBeenCalledTimes(1);
		expect(sink.resolveProblem).toHaveBeenCalledWith(RISK);
	});

	it("清一条没撞过的路:什么都不发生", () => {
		const { sink, layers } = setup(IN);
		layers.resolveRisk("dynamic");
		layers.resolveFailure({ code: "dynamic_fetch_failed" });
		expect(sink.resolveProblem).not.toHaveBeenCalled();
	});
});

describe("第三层:各项请求失败", () => {
	it("每次失败都报(幂等):来源级与订阅级各按 externalId + code 一条,带私聊", () => {
		const { sink, layers } = setup(IN);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "码 -509" });
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "码 -510" });
		layers.reportFailure({ externalId: "7", code: "live_monitor_stopped", message: "停了" });
		expect(sink.reportProblem.mock.calls.map(([p]) => p)).toEqual([
			{ code: "dynamic_fetch_failed", message: "码 -509", notify: true },
			{ code: "dynamic_fetch_failed", message: "码 -510", notify: true },
			{ externalId: "7", code: "live_monitor_stopped", message: "停了", notify: true },
		]);
	});

	it("resolveFailure:缺省是普通的清;notify: false 才静默", () => {
		const { sink, layers } = setup(IN);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		layers.reportFailure({ externalId: "7", code: "live_monitor_stopped", message: "y" });
		layers.resolveFailure({ code: "dynamic_fetch_failed" });
		layers.resolveFailure({ externalId: "7", code: "live_monitor_stopped" }, { notify: false });
		expect(sink.resolveProblem.mock.calls.map(([p]) => p)).toEqual([
			{ code: "dynamic_fetch_failed" },
			{ externalId: "7", code: "live_monitor_stopped", notify: false },
		]);
	});

	it("清掉之后同一个码再来一次:表里要有(不被「已报过」吞掉)", () => {
		const { sink, set, layers } = setup(IN);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		set(EXPIRED);
		set(IN);
		sink.reportProblem.mockClear();
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		expect(sink.reportProblem).toHaveBeenCalledTimes(1);
	});
});

describe("先造、后接、补报", () => {
	it("接上前报的:接上时整份补报,只补最上面一层(风控压住第三层)", () => {
		const { sink, layers } = setup(IN, false);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		layers.reportRisk("dynamic");
		expect(sink.reportProblem).not.toHaveBeenCalled();

		layers.attach(sink);
		expect(sink.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["risk_controlled"]);
	});

	it("没有更高层:第三层逐条补报", () => {
		const { sink, layers } = setup(IN, false);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		layers.reportFailure({ externalId: "7", code: "live_monitor_stopped", message: "y" });
		layers.attach(sink);
		expect(sink.reportProblem.mock.calls.map(([p]) => p.code).sort()).toEqual([
			"dynamic_fetch_failed",
			"live_monitor_stopped",
		]);
	});

	it("未登录最优先:只补它一条", () => {
		const { sink, layers } = setup(EXPIRED, false);
		layers.reportRisk("dynamic");
		layers.attach(sink);
		expect(sink.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["auth_lost"]);
	});

	it("接上之前开了又清掉的不会出现", () => {
		const { sink, layers } = setup(IN, false);
		layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
		layers.resolveFailure({ code: "dynamic_fetch_failed" });
		layers.attach(sink);
		expect(sink.reportProblem).not.toHaveBeenCalled();
		expect(sink.resolveProblem).not.toHaveBeenCalled();
	});

	it("摘下后再报不调核心,记在自己手里;再接上补报现状", () => {
		const { sink, layers, set } = setup(IN);
		layers.detach();
		layers.reportRisk("dynamic");
		set(EXPIRED);
		layers.resolveRisk("nope");
		expect(sink.reportProblem).not.toHaveBeenCalled();
		expect(sink.resolveProblem).not.toHaveBeenCalled();

		layers.attach(sink);
		expect(sink.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["auth_lost"]);
	});

	it("dispose:不再听登录口,也不再调核心", () => {
		const { sink, layers, set, unsubscribed, listeners } = setup(IN);
		layers.dispose();
		expect(unsubscribed).toHaveBeenCalledTimes(1);
		expect(listeners.size).toBe(0);
		set(EXPIRED);
		layers.reportRisk("dynamic");
		expect(sink.reportProblem).not.toHaveBeenCalled();
	});
});

describe("核心那头抛错不往外传", () => {
	function throwingSink(): ProblemSink {
		return {
			reportProblem: () => {
				throw new Error("核心那头坏了");
			},
			resolveProblem: () => {
				throw new Error("核心那头坏了");
			},
		};
	}

	it("每个方法都接住,记一行 warn", () => {
		const logger = makeLogger();
		const fake = makeAuth(IN);
		const layers = createProblemLayers({ auth: fake.auth, logger });
		layers.attach(throwingSink());
		expect(() => {
			layers.reportRisk("dynamic");
			layers.resolveRisk("dynamic");
			layers.reportFailure({ code: "dynamic_fetch_failed", message: "x" });
			layers.resolveFailure({ code: "dynamic_fetch_failed" });
			fake.set(EXPIRED);
			fake.set(IN);
			layers.detach();
			layers.attach(throwingSink());
		}).not.toThrow();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("抛过之后状态照常维护(下一次照样报)", () => {
		const { layers } = setup(IN, false);
		let calls = 0;
		layers.attach({
			reportProblem: () => {
				calls += 1;
				if (calls === 1) throw new Error("第一次坏");
			},
			resolveProblem: () => {},
		});
		layers.reportRisk("dynamic");
		layers.reportRisk("live:1");
		layers.resolveRisk("dynamic");
		layers.resolveRisk("live:1");
		layers.reportRisk("dynamic");
		expect(calls).toBe(2);
	});
});
