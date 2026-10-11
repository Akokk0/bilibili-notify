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

describe("未登录层:只看 AuthState.status", () => {
	it("开机 expired:attach 时报一条 auth_lost,来源级、带私聊", () => {
		const { core } = setup(EXPIRED);
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginExpired.text,
			notify: true,
			recoveryMessage: PROBLEM_TEXTS.loginExpired.recovery,
		});
	});

	it("开机 logged-out(没登录过 / 主动退出):报一条 auth_lost,不带私聊,话是「还没有登录」", () => {
		const { core } = setup(OUT);
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginMissing.text,
			notify: false,
		});
	});

	it("开机已登录:什么都不报", () => {
		const { core } = setup(IN);
		expect(core.reportProblem).not.toHaveBeenCalled();
	});

	it("运行中掉登录(logged-in → expired):当场报,带私聊", () => {
		const { core, set } = setup(IN);
		set(EXPIRED);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginExpired.text,
			notify: true,
			recoveryMessage: PROBLEM_TEXTS.loginExpired.recovery,
		});
	});

	it("logged-in 清掉它,走普通的清(照常补「已恢复」,不带 notify)", () => {
		const { core, set } = setup(EXPIRED);
		set(IN);
		expect(core.resolveProblem).toHaveBeenCalledTimes(1);
		expect(core.resolveProblem).toHaveBeenCalledWith(LOGIN);
	});

	it("已登录时重扫 → 超时(awaiting-scan / confirming / error):一条都不开", () => {
		const { core, set } = setup(IN);
		for (const s of [SCAN, CONFIRMING, ERROR]) set(s);
		expect(core.reportProblem).not.toHaveBeenCalled();
		expect(core.resolveProblem).not.toHaveBeenCalled();
	});

	it("未登录时扫码途中(awaiting-scan / confirming / error)不清它,保持上一次的结论", () => {
		const { core, set } = setup(EXPIRED);
		for (const s of [SCAN, CONFIRMING, ERROR]) set(s);
		expect(core.resolveProblem).not.toHaveBeenCalled();
		set(IN);
		expect(core.resolveProblem).toHaveBeenCalledTimes(1);
	});

	it("开机 confirming(还没向 B 站确认):不开;之后探到失效才开", () => {
		const { core, set } = setup(CONFIRMING);
		expect(core.reportProblem).not.toHaveBeenCalled();
		set(EXPIRED);
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
	});

	it("失效后主动退出(expired → logged-out):换成不带私聊的那一句,不先清再开", () => {
		const { core, set } = setup(EXPIRED);
		core.reportProblem.mockClear();
		set(OUT);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "auth_lost",
			message: PROBLEM_TEXTS.loginMissing.text,
			notify: false,
		});
		expect(core.resolveProblem).not.toHaveBeenCalled();
	});
});

describe("压与抹", () => {
	it("未登录一开:手里的风控路在表里静默抹掉(notify: false),再报未登录", () => {
		const { core, set, layers } = setup(IN);
		layers.reportRisk("dynamic");
		layers.reportRisk("live:1");
		core.resolveProblem.mockClear();
		core.reportProblem.mockClear();

		set(EXPIRED);

		expect(core.resolveProblem.mock.calls.map(([p]) => p)).toEqual([{ ...RISK, notify: false }]);
		expect(core.reportProblem).toHaveBeenCalledTimes(1);
		expect(core.reportProblem.mock.calls[0]?.[0].code).toBe("auth_lost");
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
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
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

		layers.reportRisk("dynamic");

		expect(core.resolveProblem).toHaveBeenCalledTimes(2);
		expect(core.resolveProblem.mock.calls.every(([p]) => p.notify === false)).toBe(true);
		expect(core.reportProblem).toHaveBeenCalledWith({
			code: "risk_controlled",
			message: PROBLEM_TEXTS.riskControlled.text,
			notify: true,
			recoveryMessage: PROBLEM_TEXTS.riskControlled.recovery,
		});
	});

	it("风控开着时失败只记日志,不进表;风控清掉后它也不自己冒回来", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
		layers.reportRisk("dynamic");
		layers.reportRisk("live:1");
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

	it("未登录层与风控层报的时候带各自的 recovery;只进表的「还没登录」不带", () => {
		const expired = setup(EXPIRED);
		expect(expired.core.reportProblem.mock.calls[0]?.[0].recoveryMessage).toBe(
			PROBLEM_TEXTS.loginExpired.recovery,
		);
		const missing = setup(OUT);
		expect(missing.core.reportProblem.mock.calls[0]?.[0]).not.toHaveProperty("recoveryMessage");
		const risky = setup(IN);
		risky.layers.reportRisk("dynamic");
		expect(risky.core.reportProblem.mock.calls[0]?.[0].recoveryMessage).toBe(
			PROBLEM_TEXTS.riskControlled.recovery,
		);
		// 补报也带
		risky.layers.detach();
		risky.core.reportProblem.mockClear();
		risky.layers.attach(risky.core);
		expect(risky.core.reportProblem.mock.calls[0]?.[0].recoveryMessage).toBe(
			PROBLEM_TEXTS.riskControlled.recovery,
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
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
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

		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
		layers.reportFailure(stopped());
		set(EXPIRED); // 风控被抹掉,第三层仍压着
		core.reportProblem.mockClear();
		set(IN);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["live_monitor_stopped"]);
	});

	it("压着的 lasting 在 attach 补报时不报(只报最上面一层),压着的东西清掉后才报", () => {
		const { core, layers } = setup(IN, false);
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
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

	// 验红:revealFailures 恒用自己的 notify,除「高层开着时才第一次报」那条外都红;
	//       「说过的记号」不随同键再报带走(reported 恒 false),「压着时同一件事又报了一遍」红。
	it("报过(带私聊)→ 风控压下去 → 风控清了:冒回表里,notify 为 false,话与恢复句照旧", () => {
		const { core, layers } = setup(IN);
		layers.reportFailure(stopped());
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
		layers.reportFailure(stopped({ message: "换了原因" }));
		core.reportProblem.mockClear();

		layers.resolveRisk("dynamic");

		expect(core.reportProblem.mock.calls.map(([p]) => [p.message, p.notify])).toEqual([
			["换了原因", false],
		]);
	});

	it("冒出来之后再被压、再冒:仍然不带私聊", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("dynamic");
		layers.reportFailure(stopped());
		layers.resolveRisk("dynamic"); // 第一次冒出来,带私聊
		layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
		layers.resolveRisk("dynamic", { notify: false });
		expect(core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled", notify: false });
	});

	it("只看最后清掉的那一路:先是真解除、最后是不再适用 → 不补;反过来 → 补", () => {
		const a = setup(IN);
		a.layers.reportRisk("dynamic");
		a.layers.reportRisk("live:1");
		a.layers.resolveRisk("dynamic");
		a.layers.resolveRisk("live:1", { notify: false });
		expect(a.core.resolveProblem).toHaveBeenCalledTimes(1);
		expect(a.core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled", notify: false });

		const b = setup(IN);
		b.layers.reportRisk("dynamic");
		b.layers.reportRisk("live:1");
		b.layers.resolveRisk("dynamic", { notify: false });
		b.layers.resolveRisk("live:1");
		expect(b.core.resolveProblem).toHaveBeenCalledTimes(1);
		expect(b.core.resolveProblem).toHaveBeenCalledWith({ code: "risk_controlled" });
	});

	it("不再适用地清掉最后一路:压着的 lasting 照样冒出来", () => {
		const { core, layers } = setup(IN);
		layers.reportRisk("live:1");
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
		layers.reportRisk("dynamic");
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

	it("未登录最优先:只补它一条", () => {
		const { core, layers } = setup(EXPIRED, false);
		layers.reportRisk("dynamic");
		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["auth_lost"]);
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
		layers.reportRisk("dynamic");
		set(EXPIRED);
		layers.resolveRisk("nope");
		expect(core.reportProblem).not.toHaveBeenCalled();
		expect(core.resolveProblem).not.toHaveBeenCalled();

		layers.attach(core);
		expect(core.reportProblem.mock.calls.map(([p]) => p.code)).toEqual(["auth_lost"]);
	});

	it("dispose:不再听登录口,也不再调核心", () => {
		const { core, layers, set, unsubscribed, listeners } = setup(IN);
		layers.dispose();
		expect(unsubscribed).toHaveBeenCalledTimes(1);
		expect(listeners.size).toBe(0);
		set(EXPIRED);
		layers.reportRisk("dynamic");
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
			layers.reportRisk("dynamic");
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
		layers.reportRisk("dynamic");
		layers.reportRisk("live:1");
		layers.resolveRisk("dynamic");
		layers.resolveRisk("live:1");
		layers.reportRisk("dynamic");
		expect(calls).toBe(2);
	});
});
