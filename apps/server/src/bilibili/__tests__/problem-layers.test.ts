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
function makeCore() {
	return {
		reportProblem: vi.fn<(p: Parameters<CoreProblemsArg["reportProblem"]>[0]) => void>(),
		resolveProblem: vi.fn<(p: Parameters<CoreProblemsArg["resolveProblem"]>[0]) => void>(),
	};
}
type CoreProblemsArg = Parameters<ProblemLayers["attach"]>[0];

function setup(initial: AuthState = IN, attached = true) {
	const fake = makeAuth(initial);
	const layers = createProblemLayers({ auth: fake.auth, logger: makeLogger() });
	const core = makeCore();
	if (attached) layers.attach(core);
	return { ...fake, layers, core };
}

const LOGIN = { code: "auth_lost" };
const RISK = { code: "risk_controlled" };

/**
 * 登录问题(`auth_lost`)归宿主报(`subscriptions/login-problems.ts`),这一层自己不报、不清;
 * 它只看 `AuthState.status` 判断「掉没掉」,用来压下面两层。
 */
describe("未登录层:不报登录问题,只用来压下面两层", () => {
	/** 掉没掉登录,看一条风控报不报得上去。 */
	const riskReaches = (initial: AuthState, ...then: AuthState[]): boolean => {
		const { core, set, layers } = setup(initial);
		for (const s of then) set(s);
		layers.reportRisk("dynamic", { notify: true });
		return core.reportProblem.mock.calls.some(([p]) => p.code === "risk_controlled");
	};

	it("开机 expired / logged-out、运行中掉登录:核心那头收不到任何 auth_lost 的上报", () => {
		for (const initial of [EXPIRED, OUT]) {
			const { core } = setup(initial);
			expect(core.reportProblem).not.toHaveBeenCalled();
		}
		const { core, set } = setup(IN);
		set(EXPIRED);
		set(OUT);
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("接上(attach)时登录没好也什么都不补报", () => {
		const { core, layers } = setup(EXPIRED, false);
		layers.attach(core);
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("logged-in 不对核心清 auth_lost(清归宿主)", () => {
		const { core, set } = setup(EXPIRED);
		set(IN);
		expect(core.resolveProblem).not.toHaveBeenCalledWith(LOGIN);
		expect(core.resolveProblem).not.toHaveBeenCalled();
	});

	it("掉了登录就压着:expired / logged-out 时风控报不上去,logged-in 时报得上去", () => {
		expect(riskReaches(EXPIRED)).toBe(false);
		expect(riskReaches(OUT)).toBe(false);
		expect(riskReaches(IN)).toBe(true);
		expect(riskReaches(EXPIRED, IN)).toBe(true);
	});

	it("awaiting-scan / confirming / error 保持上一次的结论:已登录时不压,未登录时不松", () => {
		expect(riskReaches(IN, SCAN, CONFIRMING, ERROR)).toBe(true);
		expect(riskReaches(EXPIRED, SCAN, CONFIRMING, ERROR)).toBe(false);
	});

	it("开机 confirming(还没向 B 站确认):不压;之后探到失效才压", () => {
		expect(riskReaches(CONFIRMING)).toBe(true);
		expect(riskReaches(CONFIRMING, EXPIRED)).toBe(false);
	});

	it("失效后主动退出(expired → logged-out):仍然压着", () => {
		expect(riskReaches(EXPIRED, OUT)).toBe(false);
	});
});

describe("压与抹", () => {
	it("未登录一开:手里的风控路在表里静默抹掉(notify: false),自己不报未登录", () => {
		const { core, set, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("live:1", { notify: true });
		core.resolveProblem.mockClear();
		core.reportProblem.mockClear();

		set(EXPIRED);

		expect(core.resolveProblem.mock.calls.map(([p]) => p)).toEqual([{ ...RISK, notify: false }]);
		expect(core.reportProblem).not.toHaveBeenCalled();
		// 风控路清空了:之后这些路的「清」不再引出任何一次核心调用
		layers.resolveRisk("dynamic");
		expect(core.resolveProblem).toHaveBeenCalledTimes(1);
	});

	it("未登录一开:手里的第三层失败也静默抹掉", () => {
		const { core, set, layers } = setup(IN);
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "停了",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		core.resolveProblem.mockClear();

		set(EXPIRED);

		expect(core.resolveProblem.mock.calls.map(([p]) => p)).toEqual([
			{ externalId: "7", code: "live_monitor_stopped", notify: false },
			{ code: "dynamic_fetch_failed", notify: false },
		]);
	});

	it("未登录开着时:风控与失败只记日志,不进表", () => {
		const { core, layers } = setup(EXPIRED);
		core.reportProblem.mockClear();
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("未登录开着时存的东西不许等它清掉后自己冒出来:清掉再重新接上,表里只有现状(空)", () => {
		const { core, set, layers } = setup(EXPIRED);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		set(IN);
		layers.detach();
		core.reportProblem.mockClear();
		layers.attach(core);
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("风控一开:第三层全清空并静默抹掉,再报风控(带私聊)", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "y",
			notify: true,
			lasting: false,
		});
		core.reportProblem.mockClear();
		core.resolveProblem.mockClear();

		layers.reportRisk("dynamic", { notify: true });

		expect(core.resolveProblem).toHaveBeenCalledTimes(2);
		expect(core.resolveProblem.mock.calls.every(([p]) => p.notify === false)).toBe(true);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "risk_controlled",
			message: PROBLEM_TEXTS.riskControlled.text(),
			notify: true,
			recoveryMessage: PROBLEM_TEXTS.riskControlled.recovery(),
		});
	});

	it("风控开着时失败只记日志,不进表;风控清掉后它也不自己冒回来", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		core.reportProblem.mockClear();
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		expect(core.reportProblem).not.toHaveBeenCalled();
		layers.resolveRisk("dynamic");
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("两路风控各清各的,最后一路清了才清表(普通的清);同一路重复撞只报一次", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("live:1", { notify: true });
		expect(core.reportProblem).toHaveBeenCalledTimes(1);

		layers.resolveRisk("dynamic");
		expect(core.resolveProblem).not.toHaveBeenCalled();
		layers.resolveRisk("live:1");
		expect(core.resolveProblem).toHaveBeenCalledTimes(1);
		expect(core.resolveProblem).toHaveBeenCalledWith(RISK);
	});

	it("清一条没撞过的路:什么都不发生", () => {
		const { core, layers } = setup(IN);
		layers.resolveRisk("dynamic");
		layers.resolveFailure({ code: "dynamic_fetch_failed" });
		expect(core.resolveProblem).not.toHaveBeenCalled();
	});
});

describe("第三层:各项请求失败", () => {
	it("每次失败都报(幂等):来源级与订阅级各按 externalId + code 一条,带私聊", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "码 -509",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "码 -510",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "停了",
			notify: true,
			lasting: false,
		});
		expect(core.reportProblem.mock.calls.map(([p]) => p)).toEqual([
			{ code: "dynamic_fetch_failed", message: "码 -509", notify: true },
			{ code: "dynamic_fetch_failed", message: "码 -510", notify: true },
			{ externalId: "7", code: "live_monitor_stopped", message: "停了", notify: true },
		]);
	});

	it("带不带私聊由调用方定:notify 原样带给核心,补报时带的是存下的那一格", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "不私聊",
			notify: false,
			lasting: false,
		});
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "私聊",
			notify: true,
			lasting: false,
		});
		expect(core.reportProblem.mock.calls.map(([p]) => p.notify)).toEqual([false, true]);

		layers.detach();
		core.reportProblem.mockClear();
		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => [p.code, p.notify])).toEqual([
			["dynamic_fetch_failed", false],
			["live_monitor_stopped", true],
		]);
	});

	it("reportFailure 的 recoveryMessage 存下来原样带给核心,补报时带上;不给就没有这一格", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "停了",
			notify: true,
			lasting: true,
			recoveryMessage: "连上啦",
		});
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: false,
			lasting: false,
		});
		expect(core.reportProblem.mock.calls[0]?.[0]).toMatchObject({ recoveryMessage: "连上啦" });
		expect("recoveryMessage" in (core.reportProblem.mock.calls[1]?.[0] ?? {})).toBe(false);

		layers.detach();
		core.reportProblem.mockClear();
		layers.attach(core);
		const byCode = new Map(core.reportProblem.mock.calls.map(([p]) => [p.code, p]));
		expect(byCode.get("live_monitor_stopped")?.recoveryMessage).toBe("连上啦");
		expect(byCode.get("dynamic_fetch_failed")).not.toHaveProperty("recoveryMessage");
	});

	it("风控层报的时候带它的 recovery,补报也带", () => {
		const risky = setup(IN);
		risky.layers.reportRisk("dynamic", { notify: true });
		expect(risky.core.reportProblem.mock.calls[0]?.[0].recoveryMessage).toBe(
			PROBLEM_TEXTS.riskControlled.recovery(),
		);
		// 补报也带
		risky.layers.detach();
		risky.core.reportProblem.mockClear();
		risky.layers.attach(risky.core);
		expect(risky.core.reportProblem.mock.calls[0]?.[0].recoveryMessage).toBe(
			PROBLEM_TEXTS.riskControlled.recovery(),
		);
	});

	it("resolveFailure:缺省是普通的清;notify: false 才静默", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "y",
			notify: true,
			lasting: false,
		});
		layers.resolveFailure({ code: "dynamic_fetch_failed" });
		layers.resolveFailure({ externalId: "7", code: "live_monitor_stopped" }, { notify: false });
		expect(core.resolveProblem.mock.calls.map(([p]) => p)).toEqual([
			{ code: "dynamic_fetch_failed" },
			{ externalId: "7", code: "live_monitor_stopped", notify: false },
		]);
	});

	it("清掉之后同一个码再来一次:表里要有(不被「已报过」吞掉)", () => {
		const { core, set, layers } = setup(IN);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		set(EXPIRED);
		set(IN);
		core.reportProblem.mockClear();
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
	});
});

/**
 * `lasting`:报一次就不再报、直到有人去修的(如直播间停止监听)。高层开着时存下但不报,高层清掉那一刻报上去;
 * 高层开起来时不清空它(只把表里已有的静默抹掉);它的主人 `resolveFailure` 时照常删。
 * `lasting: false`(会自己再报的)的行为与之前逐条一样,上面几组已经钉着。
 */
describe("第三层的 lasting", () => {
	const stopped = (over: Partial<Parameters<ProblemLayers["reportFailure"]>[0]> = {}) => ({
		externalId: "7",
		code: "live_monitor_stopped",
		message: "停了",
		notify: true,
		lasting: true,
		recoveryMessage: "连上啦",
		...over,
	});

	it("风控开着时报 lasting 的:表里没有它;风控清了:报上去,带它自己的 notify 与 recoveryMessage", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		core.reportProblem.mockClear();

		layers.reportFailure(stopped({ notify: false }));
		expect(core.reportProblem).not.toHaveBeenCalled();

		layers.resolveRisk("dynamic");
		expect(core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled" });
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
		expect(core.reportProblem).toHaveBeenCalledWith({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "停了",
			notify: false,
			recoveryMessage: "连上啦",
		});
	});

	it("风控压着时被主人 resolveFailure:风控清了也不报,对核心也什么都没说", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure(stopped());
		core.resolveProblem.mockClear();

		layers.resolveFailure({ externalId: "7", code: "live_monitor_stopped" }, { notify: false });
		expect(core.resolveProblem).not.toHaveBeenCalled();

		core.reportProblem.mockClear();
		layers.resolveRisk("dynamic");
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("未登录压着:报的 lasting 的存下不报;登录好了才报", () => {
		const { core, layers, set } = setup(EXPIRED);
		core.reportProblem.mockClear();
		layers.reportFailure(stopped());
		expect(core.reportProblem).not.toHaveBeenCalled();

		set(IN);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});

	it("未登录压着时被主人 resolveFailure:登录好了也不报", () => {
		const { core, layers, set } = setup(EXPIRED);
		layers.reportFailure(stopped());
		layers.resolveFailure({ externalId: "7", code: "live_monitor_stopped" }, { notify: false });
		core.reportProblem.mockClear();
		set(IN);
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("未登录开起来:表里已有的 lasting 静默抹掉,但手里留着;登录好了重新报上去", () => {
		const { core, layers, set } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: false,
			lasting: false,
		});
		core.reportProblem.mockClear();
		core.resolveProblem.mockClear();

		set(EXPIRED);
		expect(core.resolveProblem.mock.calls.map(([p]) => [p.code, p.notify])).toEqual([
			["live_monitor_stopped", false],
			["dynamic_fetch_failed", false],
		]);

		core.reportProblem.mockClear();
		set(IN);
		// 只有 lasting 的回来了;会自己再报的那条不冒回来
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});

	it("风控开起来:表里已有的 lasting 静默抹掉,手里留着;风控清了重新报上去", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		core.resolveProblem.mockClear();

		layers.reportRisk("dynamic", { notify: true });
		expect(core.resolveProblem).toHaveBeenCalledWith({
			externalId: "7",
			code: "live_monitor_stopped",
			notify: false,
		});

		core.reportProblem.mockClear();
		layers.resolveRisk("dynamic");
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});

	it("两层都压过:未登录清了而风控还开着,就继续压着(登录开时风控被清空,所以只有未登录一层)", () => {
		const { core, layers, set } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure(stopped());
		set(EXPIRED); // 风控被抹掉,第三层仍压着
		core.reportProblem.mockClear();
		set(IN);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});

	it("压着的 lasting 在 attach 补报时不报(只报最上面一层),压着的东西清掉后才报", () => {
		const { core, layers } = setup(IN, false);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure(stopped());
		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["risk_controlled"]);

		core.reportProblem.mockClear();
		layers.resolveRisk("dynamic");
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});

	it("没压着的 lasting 当场报,和别的第三层一样;同键再报只换文案", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportFailure(stopped({ message: "换了原因" }));
		expect(core.reportProblem.mock.calls.map(([p]) => p.message)).toEqual(["停了", "换了原因"]);
	});

	it("lasting: false 与之前一样:高层开着时不存,清掉后也不冒出来", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: false,
			lasting: false,
		});
		core.reportProblem.mockClear();
		layers.resolveRisk("dynamic");
		expect(core.reportProblem).not.toHaveBeenCalled();
	});
});

/**
 * 说过的一次性故障:曾经报给过核心(主人当时已经听过一遍)的 `lasting` 失败,被高层压下去再冒出来时
 * 报回表里但不带私聊(文案、恢复句照旧);高层开着时才第一次报的,冒出来时照它自己的 `notify`。
 */
describe("说过的一次性故障不说第二遍", () => {
	const stopped = (over: Partial<Parameters<ProblemLayers["reportFailure"]>[0]> = {}) => ({
		externalId: "7",
		code: "live_monitor_stopped",
		message: "停了",
		notify: true,
		lasting: true,
		recoveryMessage: "连上啦",
		...over,
	});

	// 验红:revealFailures 里不把报给过核心的记成静默(muted),除「高层开着时才第一次报」那条外都红;
	//       「说过的记号」不随同键再报带走(reported 恒 false),「压着时同一件事又报了一遍」红。
	it("报过(带私聊)→ 风控压下去 → 风控清了:冒回表里,notify 为 false,话与恢复句照旧", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportRisk("dynamic", { notify: true });
		core.reportProblem.mockClear();

		layers.resolveRisk("dynamic");

		expect(core.reportProblem).toHaveBeenCalledTimes(1);
		expect(core.reportProblem).toHaveBeenCalledWith({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "停了",
			notify: false,
			recoveryMessage: "连上啦",
		});
	});

	it("报过(带私聊)→ 未登录压下去 → 登录好了:同样不带私聊", () => {
		const { core, layers, set } = setup(IN);
		layers.reportFailure(stopped());
		set(EXPIRED);
		core.reportProblem.mockClear();

		set(IN);

		expect(core.reportProblem.mock.calls.map(([p]) => [p.code, p.notify])).toEqual([
			["live_monitor_stopped", false],
		]);
	});

	it("高层开着时才第一次报的(从没到过核心):冒出来时照它自己的 notify", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure(stopped());
		core.reportProblem.mockClear();

		layers.resolveRisk("dynamic");

		expect(core.reportProblem.mock.calls.map(([p]) => [p.code, p.notify])).toEqual([
			["live_monitor_stopped", true],
		]);
	});

	it("压着时同一件事又报了一遍:「说过」的记号跟着走,冒出来仍不带私聊", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure(stopped({ message: "换了原因" }));
		core.reportProblem.mockClear();

		layers.resolveRisk("dynamic");

		expect(core.reportProblem.mock.calls.map(([p]) => [p.message, p.notify])).toEqual([
			["换了原因", false],
		]);
	});

	it("冒出来之后再被压、再冒:仍然不带私聊", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportFailure(stopped());
		layers.resolveRisk("dynamic"); // 第一次冒出来,带私聊
		layers.reportRisk("dynamic", { notify: true });
		core.reportProblem.mockClear();

		layers.resolveRisk("dynamic");

		expect(core.reportProblem.mock.calls.map(([p]) => p.notify)).toEqual([false]);
	});
});

/** 风控的清有两种说法:真解除(补「风控已解除」)与不再适用(`notify: false`,不补)。 */
describe("风控的清:真解除与不再适用", () => {
	// 验红:去掉 resolveRisk 里 `notify: false` 的透传,下面前两条红。
	it("最后一路用 notify: false 清:给核心的清带 notify: false(不补「已恢复」)", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.resolveRisk("dynamic", { notify: false });
		expect(core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled", notify: false });
	});

	it("只看最后清掉的那一路:先是真解除、最后是不再适用 → 不补;反过来 → 补", () => {
		const a = setup(IN);
		a.layers.reportRisk("dynamic", { notify: true });
		a.layers.reportRisk("live:1", { notify: true });
		a.layers.resolveRisk("dynamic");
		a.layers.resolveRisk("live:1", { notify: false });
		expect(a.core.resolveProblem).toHaveBeenCalledTimes(1);
		expect(a.core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled", notify: false });

		const b = setup(IN);
		b.layers.reportRisk("dynamic", { notify: true });
		b.layers.reportRisk("live:1", { notify: true });
		b.layers.resolveRisk("dynamic", { notify: false });
		b.layers.resolveRisk("live:1");
		expect(b.core.resolveProblem).toHaveBeenCalledTimes(1);
		expect(b.core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled" });
	});

	it("不再适用地清掉最后一路:压着的 lasting 照样冒出来", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("live:1", { notify: true });
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "停了",
			notify: true,
			lasting: true,
		});
		core.reportProblem.mockClear();
		layers.resolveRisk("live:1", { notify: false });
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});
});

describe("先造、后接、补报", () => {
	it("接上前报的:接上时整份补报,只补最上面一层(风控压住第三层)", () => {
		const { core, layers } = setup(IN, false);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		layers.reportRisk("dynamic", { notify: true });
		expect(core.reportProblem).not.toHaveBeenCalled();

		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["risk_controlled"]);
	});

	it("没有更高层:第三层逐条补报", () => {
		const { core, layers } = setup(IN, false);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		layers.reportFailure({
			externalId: "7",
			code: "live_monitor_stopped",
			message: "y",
			notify: true,
			lasting: false,
		});
		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code).sort()).toEqual([
			"dynamic_fetch_failed",
			"live_monitor_stopped",
		]);
	});

	it("未登录最优先:压着风控,接上时什么都不补(登录问题归宿主)", () => {
		const { core, layers } = setup(EXPIRED, false);
		layers.reportRisk("dynamic", { notify: true });
		layers.attach(core);
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("接上之前开了又清掉的不会出现", () => {
		const { core, layers } = setup(IN, false);
		layers.reportFailure({
			code: "dynamic_fetch_failed",
			message: "x",
			notify: true,
			lasting: false,
		});
		layers.resolveFailure({ code: "dynamic_fetch_failed" });
		layers.attach(core);
		expect(core.reportProblem).not.toHaveBeenCalled();
		expect(core.resolveProblem).not.toHaveBeenCalled();
	});

	it("摘下后再报不调核心,记在自己手里;再接上补报现状", () => {
		const { core, layers, set } = setup(IN);
		layers.detach();
		layers.reportRisk("dynamic", { notify: true });
		set(IN);
		layers.resolveRisk("nope");
		expect(core.reportProblem).not.toHaveBeenCalled();
		expect(core.resolveProblem).not.toHaveBeenCalled();

		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["risk_controlled"]);
	});

	it("dispose:不再听登录口,也不再调核心", () => {
		const { core, layers, set, unsubscribed, listeners } = setup(IN);
		layers.dispose();
		expect(unsubscribed).toHaveBeenCalledTimes(1);
		expect(listeners.size).toBe(0);
		set(EXPIRED);
		layers.reportRisk("dynamic", { notify: true });
		expect(core.reportProblem).not.toHaveBeenCalled();
	});
});

describe("核心那头抛错不往外传", () => {
	function throwingCore(): CoreProblemsArg {
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
		layers.attach(throwingCore());
		expect(() => {
			layers.reportRisk("dynamic", { notify: true });
			layers.resolveRisk("dynamic");
			layers.reportFailure({
				code: "dynamic_fetch_failed",
				message: "x",
				notify: true,
				lasting: false,
			});
			layers.resolveFailure({ code: "dynamic_fetch_failed" });
			fake.set(EXPIRED);
			fake.set(IN);
			layers.detach();
			layers.attach(throwingCore());
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
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("live:1", { notify: true });
		layers.resolveRisk("dynamic");
		layers.resolveRisk("live:1");
		layers.reportRisk("dynamic", { notify: true });
		expect(calls).toBe(2);
	});
});

/**
 * S-4:一条 `lasting` 的失败被高层压过、静默冒出来之后,在它被清掉之前,同一件事再报多少次都不再带私聊
 * (重连补跑里取房间信息一直失败的房间每一轮都会再报一次停监)。
 */
describe("静默冒出来之后同一件事再报", () => {
	const stopped = (over: Partial<Parameters<ProblemLayers["reportFailure"]>[0]> = {}) => ({
		externalId: "7",
		code: "live_monitor_stopped",
		message: "停了",
		notify: true,
		lasting: true,
		recoveryMessage: "连上啦",
		...over,
	});
	const notifies = (core: ReturnType<typeof makeCore>) =>
		core.reportProblem.mock.calls.map(([p]) => [p.code, p.message, p.notify]);

	// 验红(Y1):再报时不带走「静默」的记号(muted 恒 false),前两条红。
	it("说过 → 风控压 → 风控清(静默冒出来)→ 再报同一条:给核心的仍是 notify: false,报几次都一样", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportRisk("dynamic", { notify: true });
		layers.resolveRisk("dynamic");
		core.reportProblem.mockClear();

		layers.reportFailure(stopped());
		layers.reportFailure(stopped({ message: "换了原因" }));
		layers.reportFailure(stopped({ message: "换了原因" }));

		expect(notifies(core)).toEqual([
			["live_monitor_stopped", "停了", false],
			["live_monitor_stopped", "换了原因", false],
			["live_monitor_stopped", "换了原因", false],
		]);
	});

	it("未登录压过的也一样", () => {
		const { core, layers, set } = setup(IN);
		layers.reportFailure(stopped());
		set(EXPIRED);
		set(IN);
		core.reportProblem.mockClear();

		layers.reportFailure(stopped());

		expect(notifies(core)).toEqual([["live_monitor_stopped", "停了", false]]);
	});

	it("清掉之后再报是新的一条:照它自己的 notify", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportRisk("dynamic", { notify: true });
		layers.resolveRisk("dynamic");
		layers.resolveFailure({ externalId: "7", code: "live_monitor_stopped" });
		core.reportProblem.mockClear();

		layers.reportFailure(stopped());

		expect(notifies(core)).toEqual([["live_monitor_stopped", "停了", true]]);
	});

	it("对照:从没被压过的,再报照旧带它自己的 notify(头一句还在再送时,再报一次不许把它掐掉)", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportFailure(stopped({ message: "换了原因" }));
		expect(notifies(core)).toEqual([
			["live_monitor_stopped", "停了", true],
			["live_monitor_stopped", "换了原因", true],
		]);
	});

	it("摘下再接上(来源重启,表整份清过):是新的一条,照它自己的 notify", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportRisk("dynamic", { notify: true });
		layers.resolveRisk("dynamic");
		layers.detach();
		core.reportProblem.mockClear();

		layers.attach(core);
		layers.reportFailure(stopped());

		expect(notifies(core)).toEqual([
			["live_monitor_stopped", "停了", true],
			["live_monitor_stopped", "停了", true],
		]);
	});
});

/**
 * 风控层记住每一路要不要私聊(已定 26):直播预检被拦只进表;拉动态被风控才私聊。
 * 报给核心的条目带不带私聊只升不降:有一路要私聊的进来就再报一次带私聊的,那一路先走了也不撤回。
 */
describe("风控层:每一路要不要私聊", () => {
	const riskCalls = (core: ReturnType<typeof makeCore>) =>
		core.reportProblem.mock.calls
			.filter(([p]) => p.code === "risk_controlled")
			.map(([p]) => p.notify);

	// 验红:reportRiskEntry 恒带私聊,第一、二、五条红;去掉「由假变真再报一次」,第二条红。
	it("只有不要私聊的路:报给核心的风控条目 notify 为 false,话与恢复句照旧", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("live:1", { notify: false });
		layers.reportRisk("live:2", { notify: false });
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "risk_controlled",
			message: PROBLEM_TEXTS.riskControlled.text(),
			notify: false,
			recoveryMessage: PROBLEM_TEXTS.riskControlled.recovery(),
		});
	});

	it("之后有一路要私聊的进来:再报一次、notify 为 true;再来别的路不再报", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("live:1", { notify: false });
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("live:2", { notify: false });
		expect(riskCalls(core)).toEqual([false, true]);
	});

	it("要私聊的那一路先开:带私聊报一次;不要私聊的路后进来不再报", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.reportRisk("live:1", { notify: false });
		expect(riskCalls(core)).toEqual([true]);
	});

	it("要私聊的那一路先走了、只剩不要私聊的:不撤回(不再报),条目照旧开着;全走了才清", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("live:1", { notify: false });
		layers.reportRisk("dynamic", { notify: true });
		core.reportProblem.mockClear();

		layers.resolveRisk("dynamic");
		expect(core.reportProblem).not.toHaveBeenCalled();
		expect(core.resolveProblem).not.toHaveBeenCalled();
		// 摘下再接上:补报的仍是带私聊的那一份(说过的不撤回)
		layers.detach();
		layers.attach(core);
		expect(riskCalls(core)).toEqual([true]);

		layers.resolveRisk("live:1");
		expect(core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled" });
	});

	it("风控层清掉之后重新开:带不带私聊从头算", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic", { notify: true });
		layers.resolveRisk("dynamic");
		core.reportProblem.mockClear();
		layers.reportRisk("live:1", { notify: false });
		expect(riskCalls(core)).toEqual([false]);

		// 未登录抹掉风控之后也一样
		const b = setup(IN);
		b.layers.reportRisk("dynamic", { notify: true });
		b.set(EXPIRED);
		b.set(IN);
		b.core.reportProblem.mockClear();
		b.layers.reportRisk("live:1", { notify: false });
		expect(riskCalls(b.core)).toEqual([false]);
	});

	it("接上之前只有不要私聊的路:补报的风控不带私聊", () => {
		const { core, layers } = setup(IN, false);
		layers.reportRisk("live:1", { notify: false });
		layers.attach(core);
		expect(riskCalls(core)).toEqual([false]);
	});
});
