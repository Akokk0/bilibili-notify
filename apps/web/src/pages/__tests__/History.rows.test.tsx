// @vitest-environment jsdom
/**
 * 推送历史的行:一行 = 一次推送 × 一个目标。
 *
 * 守的是:类型按 8 类标;首条本体当文案、多条挂「N 条」胶囊;四态各有 pill;行可展开逐条看
 * (文案 / 图 / 结果);目标列写目标名。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HistoryEntryView } from "../../services/dashboard";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import History from "../History";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const T1 = "22222222-2222-4222-8222-222222222222";

function row(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return {
		id: "h1",
		pushId: "p1",
		ts: new Date().toISOString(),
		kind: "live-end",
		status: "partial",
		uid: "u1",
		subscriptionId: "s1",
		targetId: T1,
		messages: [
			{ text: "下播了", role: "main", ok: true },
			{ text: "[弹幕词云]", imageRef: "h1-1.png", role: "extra", ok: true },
			{ text: "总结正文", role: "extra", ok: false, err: "boom" },
		],
		unameSnapshot: "某UP",
		...over,
	};
}

function mockApi(entries: HistoryEntryView[], subs: Subscription[] = []) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/history")) return Promise.resolve({ entries });
		if (path === "/api/targets")
			return Promise.resolve([{ id: T1, name: "测试群", platform: "onebot", enabled: true }]);
		if (path === "/api/subs") return Promise.resolve(subs);
		return Promise.resolve({ app: { historyRetentionDays: 30 } });
	});
}

function renderHistory() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<History />
		</QueryClientProvider>,
	);
}

beforeEach(() => mockApi([row()]));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("推送历史 · 行", () => {
	it("类型「下播」、首条本体当文案、「3 条」胶囊、目标名、「部分失败」pill", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		expect(screen.getByText("下播")).toBeTruthy();
		expect(screen.getByText("3 条")).toBeTruthy();
		expect(screen.getByText(/测试群/)).toBeTruthy();
		expect(screen.getByText("部分失败")).toBeTruthy();
		// 折着的时候后两条不露出来。
		expect(screen.queryByText("总结正文")).toBeNull();
	});

	it("点开一行 → 逐条看文案、图缩略与结果;再点收起", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		const toggle = screen.getByRole("button", { name: /3 条/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		await userEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("总结正文")).toBeTruthy();
		expect(screen.getByText("boom")).toBeTruthy();
		const img = screen.getByRole("img", { name: /弹幕词云/ }) as HTMLImageElement;
		expect(img.getAttribute("src")).toBe("/api/history/img/h1-1.png");
		await userEvent.click(toggle);
		expect(screen.queryByText("总结正文")).toBeNull();
	});

	it("失败行红 pill「失败」;已送达绿 pill;单条不挂胶囊", async () => {
		mockApi([
			row({ id: "a", status: "failed", messages: [{ text: "卡", role: "main", ok: false }] }),
			row({ id: "b", status: "delivered", messages: [{ text: "卡2", role: "main", ok: true }] }),
		]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("卡")).toBeTruthy());
		expect(screen.getByText("失败")).toBeTruthy();
		expect(screen.getByText("已送达")).toBeTruthy();
		// 表头的「共 N 条」不算;行上的胶囊是「N 条」打头。
		expect(screen.queryByText(/^\d+ 条/)).toBeNull();
	});

	it("搜索也搜后面几条的文案", async () => {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "总结正文");
		expect(screen.getByText("下播了")).toBeTruthy();
		await userEvent.clear(screen.getByPlaceholderText(/搜索/));
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "不存在的词");
		expect(screen.queryByText("下播了")).toBeNull();
	});
});

/** 一条 B 站订阅,资料缓存里的名字就是面板上显示的名字。 */
function biliSub(id: string, uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		id,
		cachedProfile: { name, avatar: "", sign: "", lastRefreshedAt: "2026-09-23T00:00:00Z" },
	};
}

/**
 * 行是哪条订阅(ADR-0019 决策 50):先认行上的 `subscriptionId`,不在了再找第一个 uid 相同的
 * B 站订阅 —— 与服务端重推同一条规矩。
 */
describe("推送历史 · 行对到哪条订阅", () => {
	it("行的订阅删了、同 uid 又加了一条 → 按现在那条的名字搜得到", async () => {
		mockApi(
			[row({ subscriptionId: "s-gone", unameSnapshot: "当时的名字" })],
			[biliSub("s-readded", "u1", "现在的名字")],
		);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "现在的名字");
		expect(screen.getByText("下播了")).toBeTruthy();
	});

	it("同 uid 几条订阅都在 → 行对到自己那条(按 id),不是先出现、也不是后出现的那条", async () => {
		mockApi(
			[row({ subscriptionId: "s-own", unameSnapshot: undefined })],
			[
				biliSub("s-first", "u1", "先出现的那条"),
				biliSub("s-own", "u1", "行自己那条"),
				biliSub("s-last", "u1", "后出现的那条"),
			],
		);
		renderHistory();
		// 行上没有写入期快照时,显示的就是对到的那条订阅的名字。
		await waitFor(() => expect(screen.getByText("行自己那条")).toBeTruthy());
		expect(screen.queryByText("先出现的那条")).toBeNull();
		expect(screen.queryByText("后出现的那条")).toBeNull();
		// 搜索串也是按同一条订阅拼的。
		await userEvent.type(screen.getByPlaceholderText(/搜索/), "先出现");
		expect(screen.queryByText("下播了")).toBeNull();
	});
});
