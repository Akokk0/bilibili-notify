// @vitest-environment jsdom

/**
 * **历史行上那颗「补一次」**(ADR-0017 决策 8、9)。
 *
 * 形状上的几条:
 *
 * 1. **两下完成,第二下即确认。** 点钮不发,行下面展开一条问「补哪些」,点选项才发 ——
 *    误触的代价是群里多一条撤不回的消息。但**不弹模态框**:一屏十几行,每行一个弹窗
 *    太重(决策 8)。
 * 2. **`partial` 行给两个选项**(整行重发 / 只补没到的)加一个取消;`failed` 行那一行
 *    本来就全没到,两个选项在这儿是同一件事,所以只给一个。
 * 3. **补不了的行按钮灰掉并写上原因**,不是把按钮藏掉(决策 9)—— 藏掉的话主人要么
 *    以为这行没失败过,要么以为功能坏了。
 * 4. **已送达与无目标的行根本没有这颗钮**:前者不用补,后者压根没有目标可发(决策 6)。
 *
 * 条数不在这儿算 —— 服务端按身份号算好了随行交下来(`repush.total` / `.missing`)。
 * 面板自己再算一遍就是第二份实现,判定规则一改两边就漂。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HistoryEntryView } from "../../services/dashboard";
import History from "../History";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const T1 = "22222222-2222-4222-8222-222222222222";
const TS = "2026-09-20T08:00:00.000Z";

function row(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return {
		id: "h1",
		pushId: "p1",
		ts: TS,
		kind: "live-end",
		status: "partial",
		uid: "u1",
		subscriptionId: "s1",
		targetId: T1,
		messages: [
			{ text: "下播了", role: "main", ok: true },
			{ text: "词云", role: "extra", ok: false, err: "boom" },
			{ text: "总结", role: "extra" },
		],
		unameSnapshot: "某UP",
		repush: { can: true, total: 3, missing: 2 },
		...over,
	};
}

function mockApi(entries: HistoryEntryView[]) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/history")) return Promise.resolve({ entries });
		if (path === "/api/targets")
			return Promise.resolve([{ id: T1, name: "测试群", platform: "onebot", enabled: true }]);
		if (path === "/api/subs") return Promise.resolve([]);
		return Promise.resolve({ app: { historyRetentionDays: 30 } });
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, count: 2 });
}

function renderHistory() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<History />
		</QueryClientProvider>,
	);
}

/** 那颗「补一次」的钮。 */
function repushButton() {
	return screen.getByRole("button", { name: /补/ });
}

beforeEach(() => mockApi([row()]));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("哪些行有这颗钮", () => {
	it("partial 行有", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
	});

	it("failed 行有", async () => {
		mockApi([row({ status: "failed", repush: { can: true, total: 3, missing: 3 } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
	});

	it.each([
		["已送达", "delivered" as const],
		["无目标", "no-targets" as const],
	])("%s 的行没有", async (_name, status) => {
		mockApi([row({ status, repush: undefined, targetId: status === "no-targets" ? null : T1 })]);
		renderHistory();
		await screen.findByText("某UP");
		expect(screen.queryByRole("button", { name: /补/ })).toBeNull();
	});
});

describe("两下完成", () => {
	it("🔴 点第一下不发任何东西,只展开选项", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(api.post).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /先不用了/ })).toBeTruthy();
	});

	it("partial 行给两个选项:整行重发、只补没到的,条数是服务端给的那两个数", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.getByRole("button", { name: /只补没到的.*2/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /整行重发.*3/ })).toBeTruthy();
	});

	// 那一行本来就全没到,两个选项在这儿是同一件事(决策 8)。
	it("failed 行只给一个选项", async () => {
		mockApi([row({ status: "failed", repush: { can: true, total: 3, missing: 3 } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.queryByRole("button", { name: /整行重发/ })).toBeNull();
		expect(screen.getByRole("button", { name: /重新推送.*3/ })).toBeTruthy();
	});

	/**
	 * 🔴 决策 8 那句「`failed` 行本来就全没到,两个选项是同一件事」**有个前提不总成立**:
	 * `failed` 的判据是「本体那一号没 ok」,不是「全没到」。@全体先落地且成功、本体失败的
	 * 行就是 `failed`,而它 total=2、missing=1。
	 *
	 * 这颗钮**发的是 `missing`**(决不能是 `all` —— 把已经到了的 @全体再发一遍,群里就多
	 * @ 一次全体,撤不回),所以印的数也必须是 missing。印 total 就是当面说错话。
	 */
	it("🔴 failed 行里有已经到了的消息 → 钮上印的是「要补几条」,不是整行几条", async () => {
		mockApi([row({ status: "failed", repush: { can: true, total: 2, missing: 1 } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.getByRole("button", { name: /重新推送（1 条）/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /重新推送（2 条）/ })).toBeNull();
	});

	it("第二下才发,带的是这一行的 id、ts 与选的那档", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /只补没到的/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", { ts: TS, mode: "missing" });
	});

	it("整行重发那档送的是 all", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /整行重发/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", { ts: TS, mode: "all" });
	});

	it("「先不用了」收起来,一条都不发", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /先不用了/ }));
		expect(api.post).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /只补没到的/ })).toBeNull();
	});
});

describe("发出去之后", () => {
	/**
	 * 服务端回的是 202「收下了」—— 消息一条都还没发出去。文案必须说「去补了」而不是
	 * 「补好了」,否则主人看到一行还是红的会以为功能坏了。
	 */
	it("收下了 → 说的是「去补」,不是「补好了」", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /只补没到的/ }));
		const note = await screen.findByText(/女仆.*去补/);
		expect(note.textContent).not.toMatch(/补好了|已补上/);
	});

	// 服务端那句理由**原样**显示 —— 自编一句「重推失败」等于让主人对着黑盒猜。
	it("被拒了 → 把服务端那句理由原样摆出来", async () => {
		(api.post as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("这个目标（或者它所在的连接）停用了，先启用再补"),
		);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /只补没到的/ }));
		expect(await screen.findByText(/这个目标（或者它所在的连接）停用了/)).toBeTruthy();
	});
});

describe("补不了的行", () => {
	it("按钮灰掉,原因写在 title 上(不是把按钮藏掉)", async () => {
		mockApi([
			row({
				repush: { can: false, reason: "这一行的原料已经不在了，女仆补不出原来那条" },
			}),
		]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		const btn = repushButton();
		expect(btn.hasAttribute("disabled")).toBe(true);
		expect(btn.getAttribute("title")).toContain("原料已经不在");
	});

	it("灰着的钮点不开选项", async () => {
		mockApi([row({ repush: { can: false, reason: "补不了" } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.queryByRole("button", { name: /先不用了/ })).toBeNull();
	});

	/**
	 * WS 推来的新行不带这个字段(投影在另一层)。缺省按「能补」处理 —— 一条刚刚失败的
	 * 推送,它的原件必然还在。藏起来或者灰掉都会让刚失败的那一行按不动。
	 */
	it("没带这个字段(WS 新来的行)→ 按能补处理", async () => {
		mockApi([row({ repush: undefined })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		expect(repushButton().hasAttribute("disabled")).toBe(false);
	});
});
