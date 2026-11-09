// @vitest-environment jsdom

/**
 * **历史行上那颗「补一次」**(ADR-0017 决策 8、9)。
 *
 * 形状上的几条:
 *
 * 1. **两下完成,第二下即确认。** 点钮不发,行下面展开一条问「补哪些」,点选项才发 ——
 *    误触的代价是群里多一条撤不回的消息。但**不弹模态框**:一屏十几行,每行一个弹窗
 *    太重(决策 8)。
 * 2. **`partial` 行给两个选项**(整行重发 / 只补没到的)加一个取消;别的有钮的行只给一颗、
 *    发的是 `missing`(决策 8):`failed` 行叫「重新推送」,被挡下的行与「状态已送达、可还有没发的」
 *    行叫「补发」。`failed` 行不给「整行重发」—— @全体 已经到了的话会再 @ 一次全体。
 * 3. **补不了的行按钮灰掉并写上原因**,不是把按钮藏掉(决策 9)—— 藏掉的话主人要么
 *    以为这行没失败过,要么以为功能坏了。
 * 4. **画不画这颗钮只看这一行带没带 `repush`**(决策 6,10-08 改写),不看行的状态:服务端只给
 *    「有目标、且行里还有没送到的或被挡下的消息」的行带这一格,REST 与 WS 来的行都带。全都送到了的
 *    行与无目标的行不带,所以没有钮;状态写着「已送达」可还有附加项没发的行带着,所以有。
 * 5. **被静音 / 免扰挡下的行**(`silenced`)整行没发过,展开后只有一颗「补发」。
 *
 * 条数不在这儿算 —— 服务端按身份号算好了随行交下来(`repush.total` / `.missing`)。
 * 面板自己再算一遍就是第二份实现,判定规则一改两边就漂。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handlePushEnvelope } from "../../hooks/usePushEventsChannel";
import { i18n } from "../../i18n";
import { type HistoryEntryView, historyQueryKey } from "../../services/overview";
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
		createdAt: TS,
		feature: "liveEnd",
		status: "partial",
		identity: { sourceKey: "bilibili", externalId: "u1" },
		subscriptionId: "s1",
		targetId: T1,
		messages: [
			{ text: "下播了", kind: "text", role: "main", ok: true },
			{ text: "词云", kind: "text", role: "extra", ok: false, code: "unknown", message: "boom" },
			{ text: "总结", kind: "text", role: "extra" },
		],
		nameSnapshot: "某UP",
		repush: { can: true, total: 3, missing: 2 },
		...over,
	};
}

function mockApi(entries: HistoryEntryView[]) {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/history")) return Promise.resolve({ entries });
		if (path === "/api/targets")
			return Promise.resolve([{ id: T1, name: "测试群", platform: "onebot", enabled: true }]);
		if (path === "/api/subscriptions") return Promise.resolve([]);
		return Promise.resolve({ history: { retentionDays: 30 } });
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, count: 2 });
}

function renderHistory() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<History />
		</QueryClientProvider>,
	);
	return qc;
}

/** 服务端经 WS 推来一行(建行或追加),走面板真的那条收帧的路。 */
function wsRow(
	qc: QueryClient,
	event: "history-recorded" | "history-updated",
	data: HistoryEntryView,
) {
	act(() =>
		handlePushEnvelope({ type: "push-events", event, ts: TS, data }, qc, {
			push: () => {},
			replace: () => {},
		}),
	);
}

/** 一行被静音 / 免扰挡下的:三条都没发,每条带 `isSilenced`。 */
function silencedRow(over: Partial<HistoryEntryView> = {}): HistoryEntryView {
	return row({
		status: "silenced",
		messages: [
			{ text: "下播了", kind: "text", role: "main", isSilenced: true },
			{ text: "词云", kind: "text", role: "extra", isSilenced: true },
			{ text: "总结", kind: "text", role: "extra", isSilenced: true },
		],
		repush: { can: true, total: 3, missing: 3 },
		...over,
	});
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

	it("被静音 / 免扰挡下的行有", async () => {
		mockApi([silencedRow()]);
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

	/**
	 * 🔴 画不画只看 `repush`,不看状态。补发一行被挡下的行,本体补完、附加项还没轮到就被打断:
	 * 行的标签是「已送达」,可还有两条没发 —— 没有钮的话它们再也补不出来。
	 */
	it("🔴 状态写着已送达、可 repush 说还差两条 → 有钮,标签照旧写已送达", async () => {
		mockApi([
			row({
				status: "delivered",
				messages: [
					{ text: "下播了", kind: "text", role: "main", isSilenced: true },
					{ text: "词云", kind: "text", role: "extra", isSilenced: true },
					{ text: "总结", kind: "text", role: "extra", isSilenced: true },
					{ text: "下播了", kind: "text", role: "main", ok: true, repushOf: 0 },
				],
				repush: { can: true, total: 3, missing: 2 },
			}),
		]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		expect(screen.getByText("已送达")).toBeTruthy();
		await userEvent.click(repushButton());
		// 只一颗「补发」,印的是还差的条数;不给「整行重发」(已经补到的本体不再发)。
		expect(screen.queryByRole("button", { name: /整行重发/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /只补没到的/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /^补发（2 条）/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", {
			createdAt: TS,
			mode: "missing",
		});
	});

	// 反过来:状态说失败、可这一行没带 `repush`(服务端说没得补)→ 没有钮。面板不自己按状态猜。
	it("状态是 failed、可没带 repush → 没有钮", async () => {
		mockApi([row({ status: "failed", repush: undefined })]);
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
	 * 「整行重发」这颗钮在 failed 行上**永远不出现**。
	 */
	it("🔴 failed 行里有已经到了的消息 → 只有一颗钮,印的是「要补几条」、发的是 missing,没有整行重发", async () => {
		mockApi([row({ status: "failed", repush: { can: true, total: 2, missing: 1 } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.queryByRole("button", { name: /重新推送（2 条）/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /整行重发/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /只补没到的/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /重新推送（1 条）/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", {
			createdAt: TS,
			mode: "missing",
		});
	});

	// 被挡下的行哪怕条数说已经有一条到了,也只一颗「补发」,印的是还差的条数。
	it("状态是 silenced、可已经有一条到了 → 仍是一颗「补发」,数是 missing", async () => {
		mockApi([silencedRow({ repush: { can: true, total: 3, missing: 2 } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.getByRole("button", { name: /^补发（2 条）/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /整行重发/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /只补没到的/ })).toBeNull();
	});

	it("第二下才发,带的是这一行的 id、createdAt 与选的那档", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /只补没到的/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", {
			createdAt: TS,
			mode: "missing",
		});
	});

	it("整行重发那档送的是 all", async () => {
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		await userEvent.click(screen.getByRole("button", { name: /整行重发/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", { createdAt: TS, mode: "all" });
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
		const note = await screen.findByText(/正在补发（/);
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
				repush: {
					can: false,
					code: "conflict",
					message: "这一行的原料已经不在了，女仆补不出原来那条",
				},
			}),
		]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		const btn = repushButton();
		expect(btn.hasAttribute("disabled")).toBe(true);
		expect(btn.getAttribute("title")).toContain("原料已经不在");
	});

	it("灰着的钮点不开选项", async () => {
		mockApi([row({ repush: { can: false, code: "conflict", message: "补不了" } })]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.queryByRole("button", { name: /先不用了/ })).toBeNull();
	});
});

/**
 * **WS 推来的行**自带 `repush`(服务端投影给的、没查盘的那一半,一律「能补」)。面板收帧是按 id
 * 整行替换,所以按钮在不在、印几条,都跟着最新那一帧走 —— 面板自己不留、也不猜。
 */
describe("WS 推来的行", () => {
	it("刚失败的新行立刻有钮,而且按得动", async () => {
		mockApi([]);
		const qc = renderHistory();
		// 等列表先拉完(空的),不然晚到的响应会把 WS 塞进来的那一行盖掉。
		await waitFor(() => expect(qc.getQueryData(historyQueryKey(200))).toBeDefined());
		wsRow(
			qc,
			"history-recorded",
			row({ id: "h9", status: "failed", repush: { can: true, total: 3, missing: 3 } }),
		);
		await waitFor(() => expect(repushButton()).toBeTruthy());
		expect(repushButton().hasAttribute("disabled")).toBe(false);
	});

	it("🔴 补发途中每来一帧 history-updated:钮还在,「还差几条」跟着变;补齐那一帧钮才没", async () => {
		const qc = renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.getByRole("button", { name: /只补没到的（2 条）/ })).toBeTruthy();

		const retried = { text: "词云", kind: "text", role: "extra", ok: true, repushOf: 1 } as const;
		const base = row();
		wsRow(
			qc,
			"history-updated",
			row({ messages: [...base.messages, retried], repush: { can: true, total: 3, missing: 1 } }),
		);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /只补没到的（1 条）/ })).toBeTruthy(),
		);
		expect(screen.getByRole("button", { name: "补一次" })).toBeTruthy();

		wsRow(
			qc,
			"history-updated",
			row({
				status: "delivered",
				messages: [...base.messages, retried, { ...retried, text: "总结", repushOf: 2 }],
				repush: undefined,
			}),
		);
		await waitFor(() => expect(screen.queryByRole("button", { name: /补/ })).toBeNull());
	});
});

/**
 * **补完之后那一行**(ADR-0017 决策 14 / 15 与「后果」那一节)。
 *
 * 重推是**追加进原行**(决策 14),所以 3 条的行「整行重发」之后展开是 6 条。后三条
 * 要是只按数组下标印 1..6,看上去就是三条凭空多出来的新消息 —— 既看不出是谁的重投,
 * 也看不出前三条已经作废,而 ADR 认下「行会变长、药丸上的数字会跳」换来的正是这份
 * 可追溯。号的来源是 `repushOf`(决策 15:消息按序追加、从不重排,下标就是稳定身份),
 * 「后果」那节明写它同时就是这个标记的来源,不另开字段。
 *
 * ⚠️ **「每一号只认它最后那次尝试」的判定只在服务端有一份**(决策 16)。面板只按每条
 * 自己的 `repushOf` 画;「这条被顶掉了」用的是「后面还有一条补这一号的」这个本地可见的
 * 事实,不在这儿再实现一套身份判定。
 */
describe("补完之后,展开逐条看得出谁补了谁", () => {
	/** 一行 3 条(后两条没到)→「整行重发」补了两条回来。 */
	const REPUSHED = row({
		status: "delivered",
		repush: undefined,
		messages: [
			{ text: "下播啦", kind: "text", role: "main", ok: true },
			{ text: "词云图", kind: "text", role: "extra", ok: false, code: "unknown", message: "boom" },
			{
				text: "直播总结",
				kind: "text",
				role: "extra",
				ok: false,
				code: "unknown",
				message: "boom",
			},
			{ text: "词云图", kind: "text", role: "extra", ok: true, repushOf: 1 },
			{ text: "直播总结", kind: "text", role: "extra", ok: true, repushOf: 2 },
		],
	});

	/**
	 * 展开逐条,拿到那 5 个 `<li>`(这一页只有这一处列表)。
	 *
	 * ⚠️ 钮上写的是「**3 条**」不是 5:那颗药丸数的是「本来要发几条」(没有 `repushOf` 的
	 * 那些,见 `utils/push-row.ts`),补进来的两条不算新的。数组里确实躺着 5 条,所以
	 * 下面拿到的是 5 个 `<li>` —— 这两个数不一样是对的,它们说的不是同一件事。
	 */
	async function expand(): Promise<HTMLElement[]> {
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播啦")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /3 条/ }));
		return screen.getAllByRole("listitem");
	}

	/** 行首那一格印的号。 */
	const noOf = (li: HTMLElement) => li.firstElementChild?.textContent;

	beforeEach(() => mockApi([REPUSHED]));

	it("🔴 重投那条印的是它补的**那一号**,不是它在数组里的位置", async () => {
		const items = await expand();
		expect(items.map(noOf)).toEqual(["1", "2", "3", "2", "3"]);
	});

	it("🔴 重投那条标得出是女仆补的,原来那几条不标", async () => {
		const items = await expand();
		expect(within(items[3] as HTMLElement).getByText("补发记录")).toBeTruthy();
		expect(within(items[4] as HTMLElement).getByText("补发记录")).toBeTruthy();
		expect(within(items[0] as HTMLElement).queryByText("补发记录")).toBeNull();
	});

	/**
	 * 被顶掉的那条压暗 —— 一眼看出「这条作废了,下面那条是它的重投」。判据是**后面还有
	 * 一条补这一号的**,不是「谁是最后一次」那套服务端判定。
	 */
	it("🔴 被顶掉的那条压暗并说明,没被顶掉的照旧", async () => {
		const items = await expand();
		expect(items.map(dimOf)).toEqual([false, true, true, false, false]);
		expect(within(items[1] as HTMLElement).getByText("后来已补发一次")).toBeTruthy();
	});

	it("没有 repushOf 的老行照旧按位置印 1..N", async () => {
		mockApi([row()]);
		renderHistory();
		await waitFor(() => expect(screen.getByText("下播了")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /3 条/ }));
		const items = screen.getAllByRole("listitem");
		expect(items.map(noOf)).toEqual(["1", "2", "3"]);
		expect(items.some(dimOf)).toBe(false);
	});
});

/** 压暗与否(被顶掉的那条才压)。 */
function dimOf(li: HTMLElement): boolean {
	return /\bopacity-/.test(li.className);
}

/**
 * 被静音 / 免扰挡下的行(ADR-0021 决策 34 的 🔗,10-08):照常列出,状态写「已静音」、用未激活的灰;
 * 展开后每条被挡的消息也写「已静音」;按钮只有一颗「补发」。
 */
describe("被静音 / 免扰挡下的行", () => {
	it("行的状态写「已静音」,用未激活的灰,不是警示色", async () => {
		mockApi([silencedRow()]);
		renderHistory();
		const pill = await screen.findByText("已静音");
		expect(pill.getAttribute("style") ?? "").toContain("var(--color-bn-inactive)");
		expect(screen.queryByText("失败")).toBeNull();
	});

	it("展开:每条被挡的消息写「已静音」,不写「未发送」", async () => {
		mockApi([silencedRow()]);
		renderHistory();
		await userEvent.click(await screen.findByRole("button", { name: /3 条/ }));
		// 行上一枚 + 逐条三枚。
		expect(screen.getAllByText("已静音")).toHaveLength(4);
		expect(screen.queryByText("未发送")).toBeNull();
	});

	it("补过之后:被挡的那条仍写「已静音」,补发的那条写它自己的结果", async () => {
		mockApi([
			silencedRow({
				status: "delivered",
				repush: undefined,
				messages: [
					{ text: "下播了", kind: "text", role: "main", isSilenced: true },
					{ text: "下播了", kind: "text", role: "main", ok: true, repushOf: 0 },
				],
			}),
		]);
		renderHistory();
		await userEvent.click(await screen.findByRole("button", { name: /2 条|详情/ }));
		expect(screen.getAllByText("已静音")).toHaveLength(1);
		expect(screen.getAllByText("已送达").length).toBeGreaterThanOrEqual(2);
	});

	it("只有一颗「补发」(没有「整行重发 / 只补没到的」),点了发的是没到的那几条", async () => {
		mockApi([silencedRow()]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		await userEvent.click(repushButton());
		expect(screen.getByRole("button", { name: /^补发/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /整行重发/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /只补没到的/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /重新推送/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /^补发/ }));
		expect(api.post).toHaveBeenCalledWith("/api/history/h1/repush", {
			createdAt: TS,
			mode: "missing",
		});
	});

	it("补不了(原料不在了):那颗钮灰掉并写上原因", async () => {
		mockApi([
			silencedRow({ repush: { can: false, code: "conflict", message: "这一行的原料已经不在了" } }),
		]);
		renderHistory();
		await waitFor(() => expect(repushButton()).toBeTruthy());
		expect((repushButton() as HTMLButtonElement).disabled).toBe(true);
		expect(repushButton().getAttribute("title")).toContain("原料已经不在了");
	});
});

/**
 * **被过滤的作品留的那一行**(ADR-0021 决策 34 的 🔗)。只是留痕:标签「已过滤」(和「已静音」同一支灰),
 * 展开写具体是被哪一类规则挡的,没有补发钮。它的目标那一格是空的,但不是「无目标」。
 */
describe("被过滤的行", () => {
	const filteredRow = (over: Partial<HistoryEntryView> = {}) =>
		row({
			feature: "post",
			status: "filtered",
			filteredBy: "blocked-keyword",
			targetId: null,
			repush: undefined,
			messages: [{ text: "今天也含禁词\nhttps://t.bilibili.com/1", kind: "text", role: "main" }],
			...over,
		});

	it("行的状态写「已过滤」,用未激活的灰;目标那一列是空态,不写「无目标」", async () => {
		mockApi([filteredRow()]);
		renderHistory();
		const pill = await screen.findByText("已过滤");
		expect(pill.getAttribute("style") ?? "").toContain("var(--color-bn-inactive)");
		expect(screen.queryByText("无目标")).toBeNull();
		expect(screen.getByText("→ —")).toBeTruthy();
	});

	it("没有补发钮", async () => {
		mockApi([filteredRow()]);
		renderHistory();
		await screen.findByText("已过滤");
		expect(screen.queryByRole("button", { name: /补/ })).toBeNull();
	});

	it.each([
		["blocked-keyword", "屏蔽关键词"],
		["blocked-reposts", "屏蔽转发"],
		["blocked-articles", "屏蔽文章"],
		["blocked-images", "屏蔽图集"],
		["blocked-videos", "屏蔽视频"],
		["allowlist-unmatched", "未命中白名单"],
	] as const)("展开:%s 写「%s」,那条消息不写「未发送」", async (filteredBy, label) => {
		mockApi([filteredRow({ filteredBy })]);
		renderHistory();
		await userEvent.click(await screen.findByRole("button", { name: /详情/ }));
		expect(screen.getByText(label)).toBeTruthy();
		expect(screen.queryByText("未发送")).toBeNull();
	});
});

// This scenario explicitly tests Chinese labels.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

it.each([
	[
		"ja",
		"ご主人様、届かなかったメッセージを再送できますよ。",
		"ご主人様、どのメッセージを再送しましょうか？",
		"あとから一度、再送しましたよ。",
		"メイドからの再送",
	],
	[
		"zh-TW",
		"主人，讓女僕補送沒送達的訊息吧。",
		"主人，要女僕補送哪些訊息呢？",
		"女僕後來已經補送過一次囉。",
		"女僕補送的",
	],
] as const)(
	"%s maid resend annotations preserve recorded content and require an explicit send",
	async (locale, title, question, superseded, resent) => {
		mockApi([
			row({
				messages: [
					{ text: "Original recorded 原文", kind: "text", role: "main", ok: true },
					{
						text: "Original failed 原文",
						kind: "text",
						role: "extra",
						ok: false,
						code: "unknown",
						message: "Original diagnostic 原文",
					},
					{ text: "Original pending 原文", kind: "text", role: "extra" },
					{ text: "Original resent 原文", kind: "text", role: "extra", ok: true, repushOf: 1 },
				],
				repush: { can: true, total: 3, missing: 1 },
			}),
		]);
		renderHistory();
		const original = await screen.findByText("Original recorded 原文");
		await userEvent.click(screen.getByRole("button", { name: /3 条/ }));
		const resend = repushButton();
		await userEvent.click(resend);
		for (const voice of ["maid", "plain"] as const) {
			act(() => i18n.set({ locale, voice }));
			if (voice === "maid") {
				expect(resend.getAttribute("title")).toBe(title);
				expect(screen.getByText(question)).toBeTruthy();
				expect(screen.getByText(superseded)).toBeTruthy();
				expect(screen.getByText(resent)).toBeTruthy();
			}
			expect(original.isConnected).toBe(true);
			expect(screen.getByText("Original resent 原文")).toBeTruthy();
			expect(api.post).not.toHaveBeenCalled();
		}
	},
);

it.each([
	["ja", "ご主人様、2件を再送しています。終わるとこの行を自動で更新しますよ。"],
	["zh-TW", "主人，女僕正在補發（2 則），完成後這一列會自動更新喔。"],
] as const)(
	"%s maid resend progress keeps recorded content and sends only once",
	async (locale, pending) => {
		mockApi([row()]);
		renderHistory();
		const original = await screen.findByText("下播了");
		await userEvent.click(screen.getByRole("button", { name: "补一次" }));
		await userEvent.click(screen.getByRole("button", { name: "只补没到的（2 条）" }));
		await screen.findByText(/正在补发/);
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(pending)).toBeTruthy();
		expect(screen.getByText("下播了")).toBe(original);
		expect(screen.getByText("某UP")).toBeTruthy();
		expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/history/h1/repush", {
			createdAt: TS,
			mode: "missing",
		});
	},
);

it("history controls follow locale while recorded content and missing-only resend semantics stay unchanged", async () => {
	mockApi([row()]);
	renderHistory();
	const original = await screen.findByText("下播了");
	await userEvent.click(screen.getByRole("button", { name: "补一次" }));
	for (const [locale, missing, all] of [
		["en", "Resend missing (2 messages)", "Resend entire row (3 messages)"],
		["ja", "未送信のみ再送（2件）", "行全体を再送（3件）"],
		["zh-TW", "只補未送達的（2 則）", "整列重送（3 則）"],
	] as const) {
		await act(async () => {
			i18n.set({ locale, voice: "plain" });
		});
		expect(screen.getByRole("button", { name: missing })).toBeTruthy();
		expect(screen.getByRole("button", { name: all })).toBeTruthy();
		expect(screen.getByText("下播了")).toBe(original);
		expect(api.post).not.toHaveBeenCalled();
	}
	vi.mocked(api.post).mockResolvedValueOnce({ count: 1 });
	await userEvent.click(screen.getByRole("button", { name: "只補未送達的（2 則）" }));
	expect(await screen.findByText("正在補發（1 則），處理完成後此列會自動更新。")).toBeTruthy();
	await act(async () => {
		i18n.set({ locale: "en", voice: "plain" });
	});
	expect(
		screen.getByText("Resending 1 message. This row updates when processing finishes."),
	).toBeTruthy();
	expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/history/h1/repush", {
		createdAt: TS,
		mode: "missing",
	});
	expect(screen.getByText("下播了")).toBe(original);
	expect(screen.getByText("某UP")).toBeTruthy();
});
