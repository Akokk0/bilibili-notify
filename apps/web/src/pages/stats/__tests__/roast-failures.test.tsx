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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { RoastCard } from "../RoastCard";
import { RoastPushBox } from "../RoastPushBox";
import { RoastRunNowBox } from "../RoastRunNowBox";
import { roastError } from "../RoastShell";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

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
