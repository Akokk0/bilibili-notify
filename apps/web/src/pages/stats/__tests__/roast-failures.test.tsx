// @vitest-environment jsdom
import { chooseSelect, selectOptionsOf } from "../../../__tests__/select-controls";
/**
 * 锐评这几块面板读失败的方式(ADR-0026):
 *
 * - 生成锐评没成(AI 没开、订阅不够、模型出错…)一律是非 2xx 的 `{ code, message }`,mutation 走 error
 *   分支,卡片里显示 `message`;
 * - 推送锐评:请求本身不对(引擎没起、目标没了/停用)是非 2xx;请求没问题、一个目标都没送到是
 *   200 + `{ ok: false, code, message }`,`message` 是投递那头的原话;
 * - 「试一次」:没跑起来(服务没就绪)是非 2xx;跑完了(哪怕生成没成)是 200 + 结局。
 *
 * 每个组件都挂上、点一下,看的是屏幕上的字 —— 零件各自读对了不等于这几块真的读对了。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RoastCard } from "../RoastCard";
import { RoastPushBox } from "../RoastPushBox";
import { RoastRunNowBox } from "../RoastRunNowBox";
import { roastError } from "../RoastShell";
import { SoloRoastCard } from "../SoloRoastCard";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { i18n } from "../../../i18n";
import { api } from "../../../services/api";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

/** 非 2xx 的请求失败:面板读 `message`,有 `issues` 就接在后面(与真 ApiError 同形)。 */
class FakeApiError extends Error {
	constructor(
		message: string,
		readonly issues?: Array<{ path?: (string | number)[]; message: string }>,
	) {
		super(message);
	}
}

const TARGET = { id: "11111111-1111-4111-8111-111111111111", name: "我的群", enabled: true };

function withQuery(ui: React.ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("roastError", () => {
	it("没失败 → undefined", () => {
		expect(roastError({ isError: false, error: null })).toBeUndefined();
	});

	it("失败 → message,有逐条原因接在后面", () => {
		expect(roastError({ isError: true, error: new FakeApiError("智能女仆尚未启用") })).toBe(
			"智能女仆尚未启用",
		);
		expect(
			roastError({
				isError: true,
				error: new FakeApiError("请求格式不对", [{ path: ["days"], message: "太大" }]),
			}),
		).toBe("请求格式不对：days：太大");
	});
});

describe("RoastCard —— 榜单锐评生成", () => {
	const meta = new Map();

	it.each([
		["bilibili", "UP主", "勤奋UP主"],
		["acme", "博主", "勤奋创作者"],
		["gone", undefined, "勤奋创作者"],
	])("整张榜按来源选称号,不是只看勤奋得主 (%s)", async (sourceKey, creatorNoun, title) => {
		vi.mocked(api.get).mockResolvedValue([]);
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			result: {
				pigeon: { subscriptionId: "s1", reason: "鸽" },
				diligent: { subscriptionId: "s2", reason: "勤" },
				roast: [],
				scores: [{ subscriptionId: "s3", score: 10 }],
				pushText: "",
			},
		});
		const mixedMeta = new Map([
			["s1", { name: "甲", color: "red", sourceKey: "bilibili", nouns: { creatorNoun: "UP主" } }],
			["s2", { name: "乙", color: "red", sourceKey: "bilibili", nouns: { creatorNoun: "UP主" } }],
			["s3", { name: "丙", color: "blue", sourceKey, nouns: { creatorNoun } }],
		]);
		withQuery(<RoastCard days={7} meta={mixedMeta} />);
		expect(screen.getByText(`AI 锐评 · 鸽王 vs ${title}`)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "生成 AI 锐评" }));
		await screen.findByText("勤");
		expect(screen.getByText(title)).toBeTruthy();
	});

	it("没生成成(非 2xx)→ 卡片里显示 message,按钮变成「重试」", async () => {
		vi.mocked(api.post).mockRejectedValue(new FakeApiError("至少要订阅 2 位 UP 主才评得出鸽王"));
		withQuery(<RoastCard days={7} meta={meta} />);

		fireEvent.click(screen.getByRole("button", { name: "生成 AI 锐评" }));

		expect(await screen.findByText(/生成失败:至少要订阅 2 位 UP 主才评得出鸽王/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
	});

	it("生成成了(200 + { ok: true, result })→ 摆出鸽王的理由", async () => {
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			result: {
				pigeon: { subscriptionId: "s1", reason: "一个月只发一条" },
				diligent: { subscriptionId: "s2", reason: "日更" },
				roast: [],
				scores: [],
				pushText: "本周鸽王诞生",
			},
		});
		withQuery(<RoastCard days={7} meta={meta} />);

		fireEvent.click(screen.getByRole("button", { name: "生成 AI 锐评" }));

		expect(await screen.findByText(/一个月只发一条/)).toBeTruthy();
	});
});

describe("RoastPushBox —— 推送锐评", () => {
	const payload = {
		kind: "solo" as const,
		result: { subscriptionId: "s1", verdict: "v", score: 1, highlights: [], pushText: "短评" },
	};
	it.each([
		[
			"ja",
			false,
			"送信して",
			"ご主人様、送信できませんでした：Original upstream {error}",
			"送信に失敗しました: Original upstream {error}",
		],
		["ja", true, "送信して", "✓ ご主人様、送信できましたよ（テキスト）", "✓ 送信済み（テキスト）"],
		[
			"zh-TW",
			false,
			"推播吧",
			"主人，推播沒能成功：Original upstream {error}",
			"推播失敗：Original upstream {error}",
		],
		["zh-TW", true, "推播吧", "✓ 已替主人推播（文字）", "✓ 已推播（文字）"],
	] as const)(
		"%s maid delivery result success=%s preserves payload and never sends again on voice change",
		async (locale, success, send, maid, plain) => {
			i18n.set({ locale, voice: "maid" });
			vi.mocked(api.get).mockImplementation(async (path) =>
				path === "/api/targets" ? [TARGET] : [],
			);
			vi.mocked(api.post).mockResolvedValue(
				success
					? { ok: true, mode: "text" }
					: { ok: false, code: "unavailable", message: "Original upstream {error}" },
			);
			withQuery(
				<RoastPushBox
					days={7}
					label="Original label 原文"
					text="Original summary 原文 {error}"
					payload={payload}
				/>,
			);
			await screen.findByRole("combobox");
			fireEvent.click(screen.getByRole("button", { name: send }));
			expect(await screen.findByText(maid)).toBeTruthy();
			act(() => i18n.set({ voice: "plain" }));
			expect(screen.getByText(plain)).toBeTruthy();
			expect(screen.getByText("Original summary 原文 {error}")).toBeTruthy();
			expect(screen.getByText("我的群")).toBeTruthy();
			expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/stats/roast/push", {
				targetId: TARGET.id,
				days: 7,
				...payload,
			});
		},
	);

	async function pushOnce() {
		vi.mocked(api.get).mockResolvedValue([TARGET]);
		withQuery(<RoastPushBox days={7} label="可推送短评" text="短评" payload={payload} />);
		await screen.findByRole("combobox");
		fireEvent.click(screen.getByRole("button", { name: "推送" }));
	}

	it("一个目标都没送到(200 + 失败的 Result)→ 显示投递那头的原话", async () => {
		vi.mocked(api.post).mockResolvedValue({
			ok: false,
			code: "unavailable",
			message: "机器人不在群里",
		});
		await pushOnce();
		expect(await screen.findByText("推送失败:机器人不在群里")).toBeTruthy();
		expect(screen.queryByText(/已推送/)).toBeNull();
	});

	it("目标已停用(非 2xx)→ 显示 message", async () => {
		vi.mocked(api.post).mockRejectedValue(new FakeApiError("推送目标已停用"));
		await pushOnce();
		expect(await screen.findByText("推送失败:推送目标已停用")).toBeTruthy();
	});

	it("送达 → 如实转述推的是图还是文字", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true, mode: "text" });
		await pushOnce();
		expect(await screen.findByText(/已推送（文字）/)).toBeTruthy();
	});
});

it("changing roast target clears a previous delivery result and sends the selected id", async () => {
	const second = { ...TARGET, id: "22222222-2222-4222-8222-222222222222", name: "Second" };
	vi.mocked(api.get).mockImplementation(async (p) =>
		p === "/api/targets"
			? [TARGET, second, { ...TARGET, id: "off", name: "Off", enabled: false }]
			: [],
	);
	vi.mocked(api.post).mockResolvedValue({ ok: true, mode: "text" });
	withQuery(
		<RoastPushBox
			days={7}
			label="Report"
			text="Report text"
			payload={{
				kind: "solo",
				result: { subscriptionId: "s1", verdict: "v", score: 1, highlights: [], pushText: "text" },
			}}
		/>,
	);
	await screen.findByRole("combobox");
	selectOptionsOf(screen.getByRole("combobox"));
	expect(screen.queryByRole("option", { name: "Off" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "推送" }));
	await screen.findByText(/已推送/);
	chooseSelect(screen.getByRole("combobox"), "Second");
	expect(screen.queryByText(/已推送/)).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "推送" }));
	await waitFor(() =>
		expect(api.post).toHaveBeenLastCalledWith(
			"/api/stats/roast/push",
			expect.objectContaining({ targetId: second.id }),
		),
	);
});

describe("RoastRunNowBox —— 「试一次」", () => {
	async function runOnce() {
		withQuery(
			<RoastRunNowBox approval={true} targetCount={1} dirty={false} targetName={(id) => id} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "试一次" }));
		fireEvent.click(await screen.findByRole("button", { name: "生成并私聊我" }));
	}

	it("没跑起来(服务没就绪,非 2xx)→ 「跑不起来:」后面跟 message", async () => {
		vi.mocked(api.post).mockRejectedValue(new FakeApiError("服务还没准备好，请稍后重试"));
		await runOnce();
		expect(await screen.findByText("跑不起来:服务还没准备好，请稍后重试")).toBeTruthy();
	});

	it("跑完了但生成没成(200 + gen-failed 结局)→ 由结局那一行说原因,不是「跑不起来」", async () => {
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			outcome: { kind: "gen-failed", code: "not_configured", message: "智能女仆尚未启用" },
		});
		await runOnce();
		expect(await screen.findByText("没生成出来:智能女仆尚未启用")).toBeTruthy();
		expect(screen.queryByText(/跑不起来/)).toBeNull();
	});

	it("审批开着、生成好了 → 说清在等主人回 y", async () => {
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			outcome: { kind: "pending-approval", draftId: "a3" },
		});
		await runOnce();
		expect(await screen.findByText(/回一句「y a3」就发出去/)).toBeTruthy();
	});
});

it("roast language changes retain the generated report without generating or sending again", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	vi.mocked(api.get).mockResolvedValue([]);
	vi.mocked(api.post).mockResolvedValue({
		ok: true,
		result: {
			pigeon: { subscriptionId: "s1", reason: "原始理由一" },
			diligent: { subscriptionId: "s2", reason: "原始理由二" },
			roast: [],
			scores: [{ subscriptionId: "s1", score: 17 }],
			pushText: "原始周报正文",
		},
	});
	withQuery(
		<RoastCard
			days={7}
			meta={
				new Map([
					["s1", { sourceKey: "acme", nouns: {}, name: "原作者甲", color: "red" }],
					["s2", { sourceKey: "other", nouns: {}, name: "原作者乙", color: "blue" }],
				])
			}
		/>,
	);
	expect(screen.getByText("AI review · Slacker vs diligent creator")).toBeTruthy();
	expect(screen.getByText(/Using follower growth/).textContent).toBe(
		"Using follower growth, posts and live streams for each creator over the past 7 days, select this period’s slacker and diligent creator and prepare a weekly report to send.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Generate AI review" }));
	const report = await screen.findByText("原始周报正文");
	for (const [locale, title, regenerate, score] of [
		["ja", "AIレビュー · サボり王 vs 勤勉なクリエイター", "再生成", "総合勤勉度スコア"],
		["zh-TW", "AI 銳評 · 鴿王 vs 勤奮創作者", "重新產生", "綜合勤奮度評分"],
		["en", "AI review · Slacker vs diligent creator", "Regenerate", "Overall diligence score"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByRole("button", { name: regenerate })).toBeTruthy();
		expect(screen.getByText(score)).toBeTruthy();
		expect(screen.getByText("原始周报正文")).toBe(report);
		expect(screen.getByText("原始理由一")).toBeTruthy();
		expect(screen.getAllByText("原作者甲").length).toBeGreaterThan(0);
	}
	expect(api.post).toHaveBeenCalledTimes(1);
	expect(api.post).toHaveBeenCalledWith(
		expect.stringMatching(/^\/api\/stats\/roast\?days=7&tz=/),
		{},
	);
});

it.each([
	["image", "✓ Sent (card image)", "✓ 送信済み（カード画像）", "✓ 已推播（卡片圖片）"],
	["text", "✓ Sent (text)", "✓ 送信済み（テキスト）", "✓ 已推播（文字）"],
] as const)(
	"translated report delivery keeps its selected target and %s result",
	async (mode, english, japanese, traditional) => {
		i18n.set({ locale: "en", voice: "plain" });
		const second = { ...TARGET, id: "22222222-2222-4222-8222-222222222222", name: "原目标乙" };
		vi.mocked(api.get).mockImplementation(async (path) =>
			path === "/api/targets" ? [TARGET, second] : [],
		);
		vi.mocked(api.post).mockResolvedValue({ ok: true, mode });
		const result = {
			subscriptionId: "s/raw",
			verdict: "原始评价",
			score: 17,
			highlights: [],
			pushText: "原始周报",
		};
		withQuery(
			<RoastPushBox
				days={7}
				label="Report"
				text={result.pushText}
				payload={{ kind: "solo", result }}
			/>,
		);
		const select = await screen.findByRole("combobox", { name: "Push targets" });
		chooseSelect(select, "原目标乙");
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await screen.findByText(english);
		for (const [locale, label, sent] of [
			["ja", "送信", japanese],
			["zh-TW", "推播", traditional],
			["en", "Send", english],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
			expect(screen.getByText(sent)).toBeTruthy();
			expect(screen.getByRole("combobox")).toBe(select);
			expect(select.textContent).toContain("原目标乙");
			expect(screen.getByText("原始周报")).toBeTruthy();
		}
		expect(api.post).toHaveBeenCalledTimes(1);
		expect(api.post).toHaveBeenCalledWith("/api/stats/roast/push", {
			days: 7,
			targetId: second.id,
			kind: "solo",
			result,
		});
	},
);

it("individual review translations preserve the original creator, window and generated assessment", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	vi.mocked(api.get).mockResolvedValue([]);
	vi.mocked(api.post).mockResolvedValue({
		ok: true,
		result: {
			subscriptionId: "source/a b",
			verdict: "原始总评",
			score: 31,
			highlights: [{ label: "原维度", comment: "原始点评" }],
			pushText: "原始短评正文",
		},
	});
	withQuery(<SoloRoastCard subscriptionId="source/a b" name="原作者甲" color="blue" days={7} />);
	expect(screen.getByText(/Review follower growth/).textContent).toBe(
		"Review follower growth, posts and live streams for 原作者甲 over the past 7 days, then generate an overall verdict, detailed comments and a diligence score.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Generate AI review" }));
	const assessment = await screen.findByText("原始总评");
	for (const [locale, title, label, hint] of [
		["ja", "AIレビュー · 原作者甲", "送信用の短評", "過去7日間のデータに基づく評価 · 0–100"],
		["zh-TW", "AI 銳評 · 原作者甲", "可推播短評", "依據近7日資料評分 · 0–100"],
		["en", "AI review · 原作者甲", "Short review to send", "Based on the past 7 days · 0–100"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(title)).toBeTruthy();
		expect(screen.getByText(label)).toBeTruthy();
		expect(screen.getByText(hint)).toBeTruthy();
		expect(screen.getByText("原始总评")).toBe(assessment);
		expect(screen.getByText("原维度")).toBeTruthy();
		expect(screen.getByText("原始点评")).toBeTruthy();
		expect(screen.getByText("31")).toBeTruthy();
	}
	expect(api.post).toHaveBeenCalledTimes(1);
	expect(api.post).toHaveBeenCalledWith(
		expect.stringMatching(/^\/api\/stats\/roast\/source%2Fa%20b\?days=7&tz=/),
		{},
	);
});

it.each([true, false])(
	"run-now confirmation retains its %s approval choice and encoded subscription across languages",
	async (approval) => {
		i18n.set({ locale: "en", voice: "plain" });
		vi.mocked(api.post).mockResolvedValue({
			ok: true,
			outcome: { kind: "pending-approval", draftId: "raw-17" },
		});
		withQuery(
			<RoastRunNowBox
				approval={approval}
				targetCount={1}
				dirty={true}
				targetName={(id) => id}
				subscriptionId="source/a b"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Run once" }));
		const warning = screen.getByText(/Unsaved changes/);
		const confirmText = approval
			? "Generate a review now and send it to the owner in a private message for approval. No group messages will be sent. This also checks the reply-with-y approval route."
			: "Generate a review now and send it to 1 group immediately. This is a real delivery. To review it first, enable approval above.";
		expect(screen.getByText(/Generate a review now and/).textContent).toBe(confirmText);
		for (const [locale, title, label] of [
			["ja", "レビューを今すぐ実行", approval ? "生成して個別に送信" : "実際に送信"],
			["zh-TW", "立即執行銳評", approval ? "產生並私訊給我" : "確定送出"],
			["en", "Run review now", approval ? "Generate and send privately" : "Send for real"],
		] as const) {
			act(() => i18n.set({ locale }));
			expect(screen.getByText(title)).toBeTruthy();
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
			expect(warning.isConnected).toBe(true);
			expect(api.post).not.toHaveBeenCalled();
		}
		fireEvent.click(
			screen.getByRole("button", {
				name: approval ? "Generate and send privately" : "Send for real",
			}),
		);
		await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
		expect(api.post).toHaveBeenCalledWith("/api/stats/roast/run/source%2Fa%20b", {});
	},
);
