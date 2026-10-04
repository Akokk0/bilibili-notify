// @vitest-environment jsdom

/**
 * 订阅页的标签(ADR-0034):筛选胶囊**照标签表的顺序**一枚一枚出、按 id 计数与筛选,没人挂的空标签也在;
 * 没挂任何标签的收进「无标签」;卡片角标写第一个标签的名字;订阅详情的「标签」一行改的是草稿的 `tagIds`,
 * 点保存走整份 POST、带着它。
 *
 * 接线各有各的守卫:标签表读出来以后得真的传给卡片与详情弹窗(零件各自的单测证明不了这条线接上了)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SUBSCRIPTION_TAGS_QUERY_KEY } from "../../hooks/useSubscriptionTags";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const CHAT = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };
const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const MUSIC = { id: "33333333-3333-4333-8333-333333333333", name: "音乐" };
/** 表的顺序是 杂谈 → 游戏 → 音乐:既不是名字的拼音序(音乐 < 游戏 < 杂谈),也不是各自出现的先后。 */
const TABLE = [CHAT, GAME, MUSIC];

function makeSub(uid: string, name: string, tagIds: string[]): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "bilibili", externalId: uid }),
		tagIds,
		cachedProfile: {
			name,
			sign: "",
			fans: 0,
			lastRefreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

const SUB_A = makeSub("111", "UP甲", [CHAT.id]);
const SUB_B = makeSub("222", "UP乙", [GAME.id, CHAT.id]);
const SUB_C = makeSub("333", "UP丙", []);

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { qc, ...view };
}

/** 标签那一排的胶囊(挂 chip、圆角走皮肤 pill 轴的才是;顶排「全部/已启用/已禁用」是另一排,开关也走 pill 轴),写成「名字+计数」。 */
function isTagChip(b: HTMLElement): boolean {
	return (
		b.className.includes("rounded-bn-pill") &&
		(b.getAttribute("data-bn") ?? "").split(/\s+/).includes("chip")
	);
}

function tagChips(): string[] {
	return screen
		.getAllByRole("button")
		.filter(isTagChip)
		.map((b) => b.textContent ?? "");
}

function chip(label: string): HTMLElement {
	const hit = screen
		.getAllByText(label)
		.map((n) => n.closest("button"))
		.find((b): b is HTMLButtonElement => b !== null && isTagChip(b));
	if (!hit) throw new Error(`没找到标签胶囊「${label}」`);
	return hit;
}

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path === "/api/subscriptions/tags") return Promise.resolve(TABLE);
		if (path.startsWith("/api/subscriptions/lookup")) {
			return Promise.resolve({ uid: "999", name: "查到的 999", avatar: "", sign: "", fans: 5 });
		}
		if (path === "/api/subscriptions") return Promise.resolve([SUB_A, SUB_B, SUB_C]);
		if (path === "/api/ext") return Promise.resolve({ extensions: [] });
		return Promise.resolve([]);
	});
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Subs 标签筛选", () => {
	it("胶囊照标签表的顺序出,按 id 计数;没人挂的空标签也在(计数 0);末尾是「无标签」", async () => {
		renderSubs();

		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());
		expect(tagChips()).toEqual(["全部3", "杂谈2", "游戏1", "音乐0", "无标签1"]);
	});

	it("那一排的标题叫「标签」,旧文案「分组」「未分组」不许残留", async () => {
		const { container } = renderSubs();

		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());
		expect(screen.getByText("标签")).toBeTruthy();
		expect(container.textContent).not.toContain("分组");
	});

	it("点一个标签胶囊 → 只剩挂了这个 id 的订阅(一条订阅可以挂好几个)", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());

		fireEvent.click(chip("杂谈"));
		expect(screen.getByText("UP甲")).toBeTruthy();
		expect(screen.getByText("UP乙")).toBeTruthy();
		expect(screen.queryByText("UP丙")).toBeNull();

		fireEvent.click(chip("游戏"));
		expect(screen.queryByText("UP甲")).toBeNull();
		expect(screen.getByText("UP乙")).toBeTruthy();
		expect(screen.queryByText("UP丙")).toBeNull();
	});

	it("点「无标签」→ 只剩没挂任何标签的订阅;点「全部」→ 全回来", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());

		fireEvent.click(chip("无标签"));
		expect(screen.queryByText("UP甲")).toBeNull();
		expect(screen.queryByText("UP乙")).toBeNull();
		expect(screen.getByText("UP丙")).toBeTruthy();

		fireEvent.click(chip("全部"));
		expect(screen.getByText("UP甲")).toBeTruthy();
		expect(screen.getByText("UP乙")).toBeTruthy();
		expect(screen.getByText("UP丙")).toBeTruthy();
	});

	it("选着的标签被别处删了(标签表重取后不在了)→ 退回「全部」,不留一个看不见也点不掉的筛选", async () => {
		const { qc } = renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());
		fireEvent.click(chip("游戏"));
		expect(screen.queryByText("UP甲")).toBeNull();

		act(() => {
			qc.setQueryData(SUBSCRIPTION_TAGS_QUERY_KEY, [CHAT, MUSIC]);
		});

		await waitFor(() => expect(screen.getByText("UP甲")).toBeTruthy());
		expect(screen.getByText("UP丙")).toBeTruthy();
		expect(tagChips()).toEqual(["全部3", "杂谈2", "音乐0", "无标签1"]);
	});
});

describe("Subs 卡片角标", () => {
	it("每张卡写自己第一个标签的名字(按 id 查表);没挂标签的卡什么都不写", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());

		// 卡片按订阅列表的顺序出:甲(杂谈) → 乙(游戏,第一个) → 丙(没有)。
		expect(screen.getAllByText("标签：").map((n) => n.textContent)).toEqual([
			"标签：杂谈",
			"标签：游戏",
		]);
	});
});

describe("Subs 订阅详情 × 标签", () => {
	it("详情「标签」一行显示已挂的标签名;点「编辑标签」挑完保存 → 整份 POST 带着新的 tagIds", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());

		fireEvent.click(screen.getByText("UP甲")); // 打开订阅详情
		const detail = (await screen.findAllByRole("dialog"))[0];
		expect(within(detail).getByText("杂谈")).toBeTruthy();

		fireEvent.click(within(detail).getByRole("button", { name: "编辑标签" }));
		const picker = (await screen.findAllByRole("dialog")).at(-1) as HTMLElement;
		fireEvent.click(await within(picker).findByRole("checkbox", { name: "游戏" }));
		fireEvent.click(within(picker).getByText("确定"));
		fireEvent.click(within(detail).getByRole("button", { name: "保存配置" }));

		await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
		const [path, body] = (api.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			Subscription,
		];
		expect(path).toBe("/api/subscriptions");
		expect(body.id).toBe(SUB_A.id);
		expect(body.tagIds).toEqual([CHAT.id, GAME.id]);
		expect(body).not.toHaveProperty("groups");
	});

	/**
	 * 新建模式的详情弹窗是 Subs 另一处挂 `UpDialog` 的地方(草稿还没落盘)。标签表没传进去的话,
	 * 新订阅就挑不了标签 —— 弹框只会说「还没读到」。
	 */
	it("新建订阅的配置弹窗也拿得到标签表:挑一个标签,创建的 body 带着它", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext"));

		fireEvent.click(screen.getAllByText("添加")[0] as HTMLElement);
		await screen.findByText(/选定后进入配置表单/);
		const search = within(screen.getByRole("dialog"));
		fireEvent.change(screen.getByPlaceholderText("搜索 UID 或 UP 主名字"), {
			target: { value: "999" },
		});
		fireEvent.click(search.getByRole("button", { name: "查询" }));
		await search.findByText("查到的 999");
		fireEvent.click(search.getByRole("button", { name: "下一步" }));

		const create = await screen.findByRole("button", { name: "创建订阅" });
		fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));
		const picker = (await screen.findAllByRole("dialog")).at(-1) as HTMLElement;
		fireEvent.click(await within(picker).findByRole("checkbox", { name: "游戏" }));
		fireEvent.click(within(picker).getByText("确定"));
		fireEvent.click(create);

		await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
		const [, body] = (api.post as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Subscription];
		expect(body.identity).toEqual({ sourceKey: "bilibili", externalId: "999" });
		expect(body.tagIds).toEqual([GAME.id]);
	});
});
