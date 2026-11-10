/**
 * 宿主看来源的登录状态报与清 `auth_lost`:`expired` 进表并私聊,`logged-out` 只进表,`logged-in` 清;
 * 扫码中 / 确认中 / 出错保持上一次的结论。宿主写的整句,不盖写者。
 */

import type { AuthState, Disposable, SourceAuth } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { createProblemTable, type ProblemTable } from "../../problems/problem-table.js";
import { watchLoginProblems } from "../login-problems.js";
import { makeLogger } from "./fixtures.js";

afterEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

/** 交进表的 `message` / `recoveryMessage` 是取字函数:断言时现取一次。 */
function shown(call: Parameters<ProblemTable["report"]>[0]) {
	const pick = (v: string | (() => string) | undefined) => (typeof v === "function" ? v() : v);
	return { ...call, message: pick(call.message), recoveryMessage: pick(call.recoveryMessage) };
}

const SCAN: AuthState = {
	status: "awaiting-scan",
	qr: { dataUrl: "data:image/png;base64,QR", expiresAt: "2026-10-11T00:03:00.000Z" },
};
const IN: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };
const OUT: AuthState = { status: "logged-out" };
const EXPIRED: AuthState = { status: "expired", message: "失效" };
const CONFIRMING: AuthState = { status: "confirming", message: "确认中" };
const ERROR: AuthState = { status: "error", message: "超时" };

const EXPIRED_TEXT =
	"主人，B 站的登录失效了，那边订阅的内容先收不到了。到面板的账号页重新扫码登录就好，私聊发「login bilibili」也行。";
const MISSING_TEXT =
	"主人还没有登录B 站的账号，那边订阅的内容暂时收不到。到面板的账号页扫码登录就好，私聊发「login bilibili」也行。";
const RECOVERED_TEXT = "主人，好消息：B 站的登录已经恢复啦。";

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
		listeners,
		unsubscribed,
		set(next: AuthState) {
			state = next;
			for (const fn of [...listeners]) fn();
		},
		/** 让下一次读状态抛。 */
		breakState() {
			auth.state = () => {
				throw new Error("state-boom");
			};
		},
	};
}

function setup(initial: AuthState) {
	const fake = makeAuth(initial);
	const problems = {
		report: vi.fn<ProblemTable["report"]>(),
		resolve: vi.fn<ProblemTable["resolve"]>(),
	};
	const logger = makeLogger();
	const handle = watchLoginProblems({
		auth: fake.auth,
		sourceKey: "bilibili",
		label: () => "B 站",
		problems,
		logger,
	});
	return { ...fake, problems, logger, handle };
}

describe("watchLoginProblems", () => {
	it.each([
		[
			"en",
			{
				missing:
					'You are not logged in to B 站. Content from its subscriptions cannot be received. Sign in on the dashboard Accounts page or send "login bilibili" in a private message.',
				expired:
					'Your B 站 login has expired. Content from its subscriptions cannot be received. Sign in again on the dashboard Accounts page or send "login bilibili" in a private message.',
				recovered: "Your B 站 login has been restored.",
			},
		],
		[
			"ja",
			{
				missing:
					"B 站にログインしていません。このソースの購読内容を受信できません。ダッシュボードのアカウントページでログインするか、プライベートメッセージで「login bilibili」を送信してください。",
				expired:
					"B 站のログインが失効しました。このソースの購読内容を受信できません。ダッシュボードのアカウントページで再ログインするか、プライベートメッセージで「login bilibili」を送信してください。",
				recovered: "B 站のログインが復旧しました。",
			},
		],
		[
			"zh-TW",
			{
				missing:
					"尚未登入 B 站，暫時無法接收此來源的訂閱內容。請到面板的帳號頁登入，或以私訊傳送「login bilibili」。",
				expired:
					"B 站 的登入已失效，暫時無法接收此來源的訂閱內容。請到面板的帳號頁重新登入，或以私訊傳送「login bilibili」。",
				recovered: "B 站 的登入已恢復。",
			},
		],
		[
			"zh-CN",
			{
				missing:
					"尚未登录B 站的账号，暂时无法接收此来源的订阅内容。请到面板的账号页登录，或私聊发送「login bilibili」。",
				expired:
					"B 站的登录已失效，暂时无法接收此来源的订阅内容。请到面板的账号页重新登录，或私聊发送「login bilibili」。",
				recovered: "B 站的登录已恢复。",
			},
		],
	] as const)(
		"%s reads current login wording without changing notification policy or the login command",
		(locale, text) => {
			const { problems, set, handle } = setup(OUT);
			i18n.set({ locale, voice: "plain" });
			expect(shown(problems.report.mock.calls[0]?.[0] as never)).toMatchObject({
				message: text.missing,
				notify: false,
			});
			set(EXPIRED);
			expect(shown(problems.report.mock.calls[1]?.[0] as never)).toMatchObject({
				message: text.expired,
				recoveryMessage: text.recovered,
				notify: true,
			});
			set(IN);
			expect(problems.resolve).toHaveBeenCalledExactlyOnceWith({
				reporter: "bilibili",
				code: "auth_lost",
			});
			handle.dispose();
		},
	);
	it("开机 expired:报一条 auth_lost,记在来源键名下、带私聊、宿主那句、不盖写者", () => {
		const { problems } = setup(EXPIRED);
		expect(problems.report).toHaveBeenCalledTimes(1);
		const call = problems.report.mock.calls[0]?.[0];
		expect(typeof call?.message).toBe("function");
		expect(typeof call?.recoveryMessage).toBe("function");
		expect(call && shown(call)).toEqual({
			reporter: "bilibili",
			code: "auth_lost",
			message: EXPIRED_TEXT,
			notify: true,
			recoveryMessage: RECOVERED_TEXT,
		});
	});

	it("换语言:表里开着的那条(真问题表)跟着变,不再私聊", () => {
		const table = createProblemTable({
			logger: makeLogger(),
			texts: {
				locale: () => i18n.state().locale,
				onChange: (fn) => ({ dispose: i18n.subscribe(fn) }),
			},
		});
		const changes: Array<{
			kind: string;
			notify: boolean;
			reworded?: true;
			recoveryMessage?: string;
		}> = [];
		table.subscribe((c) => changes.push(c));
		const fake = makeAuth(EXPIRED);
		let label = "B 站";
		const handle = watchLoginProblems({
			auth: fake.auth,
			sourceKey: "bilibili",
			label: () => label,
			problems: table,
			logger: makeLogger(),
		});
		try {
			expect(table.list()[0]?.message).toBe(EXPIRED_TEXT);
			const since = table.list()[0]?.since;
			label = "Current source";
			i18n.set({ locale: "en" });
			expect(table.list()[0]?.message).toBe(
				'Your Current source login has expired. Content from its subscriptions cannot be received. Sign in again on the dashboard Accounts page or send "login bilibili" in a private message.',
			);
			expect(table.list()).toHaveLength(1);
			expect(table.list()[0]?.since).toBe(since);
			// 同一条换说法，不再次 opened；通知器沿既有 reworded 规则处理。
			expect(changes.map((c) => c.kind)).toEqual(["opened", "updated"]);
			expect(changes.at(-1)?.reworded).toBe(true);
			fake.set(IN);
			expect(table.list()).toHaveLength(0);
			expect(changes.at(-1)).toMatchObject({
				kind: "closed",
				recoveryMessage: "Your Current source login has been restored.",
			});
		} finally {
			handle.dispose();
			table.dispose();
		}
	});

	it("开机 logged-out:报一条 auth_lost,不带私聊,话是「还没有登录」", () => {
		const { problems } = setup(OUT);
		expect(problems.report).toHaveBeenCalledTimes(1);
		expect(shown(problems.report.mock.calls[0]?.[0] as never)).toEqual({
			reporter: "bilibili",
			code: "auth_lost",
			message: MISSING_TEXT,
			notify: false,
		});
	});

	it("开机已登录:什么都不报", () => {
		const { problems } = setup(IN);
		expect(problems.report).not.toHaveBeenCalled();
		expect(problems.resolve).not.toHaveBeenCalled();
	});

	it("运行中掉登录(logged-in → expired):当场报,带私聊", () => {
		const { problems, set } = setup(IN);
		set(EXPIRED);
		expect(problems.report).toHaveBeenCalledTimes(1);
		expect(shown(problems.report.mock.calls[0]?.[0] as never)).toMatchObject({
			message: EXPIRED_TEXT,
			notify: true,
		});
	});

	it("expired → logged-out:同一条换成不带私聊的那一句,不先清再开;再叫一声状态没变不重报", () => {
		const { problems, set } = setup(EXPIRED);
		problems.report.mockClear();
		set(OUT);
		expect(problems.report).toHaveBeenCalledTimes(1);
		expect(shown(problems.report.mock.calls[0]?.[0] as never)).toEqual({
			reporter: "bilibili",
			code: "auth_lost",
			message: MISSING_TEXT,
			notify: false,
		});
		expect(problems.resolve).not.toHaveBeenCalled();
		set(OUT);
		expect(problems.report).toHaveBeenCalledTimes(1);
	});

	it("logged-out → expired:换回带私聊的那一句", () => {
		const { problems, set } = setup(OUT);
		problems.report.mockClear();
		set(EXPIRED);
		expect(problems.report).toHaveBeenCalledTimes(1);
		expect(shown(problems.report.mock.calls[0]?.[0] as never)).toMatchObject({
			message: EXPIRED_TEXT,
			notify: true,
		});
	});

	it("awaiting-scan / confirming / error:不动(已登录时不开,未登录时不清)", () => {
		const loggedIn = setup(IN);
		for (const s of [SCAN, CONFIRMING, ERROR]) loggedIn.set(s);
		expect(loggedIn.problems.report).not.toHaveBeenCalled();
		expect(loggedIn.problems.resolve).not.toHaveBeenCalled();

		const lost = setup(EXPIRED);
		lost.problems.report.mockClear();
		for (const s of [SCAN, CONFIRMING, ERROR]) lost.set(s);
		expect(lost.problems.report).not.toHaveBeenCalled();
		expect(lost.problems.resolve).not.toHaveBeenCalled();
	});

	it("logged-in 清掉它:走普通的清(缺省补「已恢复」,不带 notify);没开过就不清", () => {
		const { problems, set } = setup(EXPIRED);
		set(IN);
		expect(problems.resolve).toHaveBeenCalledTimes(1);
		expect(problems.resolve).toHaveBeenCalledWith({ reporter: "bilibili", code: "auth_lost" });
		set(IN);
		expect(problems.resolve).toHaveBeenCalledTimes(1);
	});

	it("dispose 之后状态再变不报,订阅摘掉", () => {
		const { problems, set, handle, unsubscribed } = setup(IN);
		handle.dispose();
		expect(unsubscribed).toHaveBeenCalledTimes(1);
		set(EXPIRED);
		expect(problems.report).not.toHaveBeenCalled();
	});

	it("读状态抛了:只记 warn,不往外抛", () => {
		const { problems, logger, set, breakState } = setup(IN);
		breakState();
		expect(() => set(EXPIRED)).not.toThrow();
		expect(problems.report).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});
});
