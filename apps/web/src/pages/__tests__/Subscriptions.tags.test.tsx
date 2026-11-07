// @vitest-environment jsdom

/**
 * 订阅页的标签(ADR-0034):筛选胶囊**照标签表的顺序**一枚一枚出、按 id 计数与筛选,没人挂的空标签也在;
 * 没挂任何标签的收进「无标签」;卡片按登记表顺序显示全部标签;订阅详情的「标签」一行改的是草稿的 `tagIds`,
 * 点保存走整份 POST、带着它。
 *
 * 接线各有各的守卫:标签表读出来以后得真的传给卡片与详情弹窗(零件各自的单测证明不了这条线接上了)。
 */

import type { SourceEntry } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SUBSCRIPTION_TAGS_QUERY_KEY } from "../../hooks/useSubscriptionTags";
import { i18n } from "../../i18n";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subscriptions from "../Subscriptions";

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

/** 来源表里在册的 B 站(新建弹窗按它画提示句)。 */
const BILI_SOURCE: SourceEntry = {
	status: "running",
	key: "bilibili",
	descriptor: {
		label: "B 站",
		externalIdNoun: "UID",
		searchAccepts: ["id", "link", "name"],
		supportedFeatures: ["post"],
	},
	has: { auth: true, liveStatus: true, preview: true },
};

function makeSub(uid: string, name: string, tagIds: string[]): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "bilibili", externalId: uid }),
		tagIds,
		cachedProfile: {
			name,
			followers: 0,
			refreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

const SUB_A = makeSub("111", "UP甲", [CHAT.id]);
const SUB_B = makeSub("222", "UP乙", [GAME.id, CHAT.id]);
const SUB_C = makeSub("333", "UP丙", []);

async function saveManager(manager: ReturnType<typeof within>) {
	const button = manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement;
	await waitFor(() => expect(button.disabled).toBe(false));
	fireEvent.click(button);
}

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subscriptions />
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
	i18n.set({ locale: "zh-CN", voice: "plain" });
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path === "/api/subscriptions/tags") return Promise.resolve(TABLE);
		// 新建弹窗搜人要来源表里在册的来源;只有 B 站一个时不画平台一排。
		if (path === "/api/sources") return Promise.resolve({ sources: [BILI_SOURCE] });
		if (path.startsWith("/api/sources/bilibili/creators")) {
			return Promise.resolve({
				candidates: [{ externalId: "999", name: "查到的 999", followers: 5 }],
			});
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

describe("Subscriptions 标签筛选", () => {
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

describe("Subscriptions 卡片角标", () => {
	it("wires the registry to every card so all labels follow registry order", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());

		expect(
			screen.getAllByRole("list", { name: "订阅标签" }).map((list) =>
				within(list)
					.getAllByRole("listitem")
					.map((n) => n.textContent),
			),
		).toEqual([["杂谈"], ["杂谈", "游戏"]]);
	});
});

describe("Subscriptions 订阅详情 × 标签", () => {
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
	 * 新建模式的详情弹窗是 Subscriptions 另一处挂 `SubscriptionDialog` 的地方(草稿还没落盘)。标签表没传进去的话,
	 * 新订阅就挑不了标签 —— 弹框只会说「还没读到」。
	 */
	it("新建订阅的配置弹窗也拿得到标签表:挑一个标签,创建的 body 带着它", async () => {
		renderSubs();
		await waitFor(() => expect(screen.getByText("无标签")).toBeTruthy());
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/sources"));

		fireEvent.click(screen.getAllByText("添加")[0] as HTMLElement);
		await screen.findByText(/配置表单/);
		const search = within(screen.getByRole("dialog"));
		fireEvent.change(await search.findByPlaceholderText("UID、主页链接或名字"), {
			target: { value: "999" },
		});
		fireEvent.click(search.getByRole("button", { name: "搜索" }));
		fireEvent.click(await search.findByRole("button", { name: /查到的 999/ }));

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
		expect(body).not.toHaveProperty("problems");
		expect(body.cachedProfile).toEqual({ name: "查到的 999", followers: 5 });
	});
});

it("manages names and order in one full-table save through the existing subscriptions page", async () => {
	renderSubs();
	fireEvent.click(await screen.findByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: " 游戏与杂谈 " },
	});
	fireEvent.click(manager.getByRole("button", { name: /上移.*游戏与杂谈/ }));
	expect(api.put).not.toHaveBeenCalled();
	vi.mocked(api.put).mockResolvedValue([{ ...GAME, name: "游戏与杂谈" }, CHAT, MUSIC]);
	await saveManager(manager);
	await waitFor(() =>
		expect(api.put).toHaveBeenCalledWith("/api/subscriptions/tags", [
			{ ...GAME, name: "游戏与杂谈" },
			CHAT,
			MUSIC,
		]),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(tagChips()).toEqual(["全部3", "游戏与杂谈1", "杂谈2", "音乐0", "无标签1"]);
});

it("stages deletion with undo; saving removes only the label and restores all subscriptions from its filter", async () => {
	let subscriptions = [SUB_A, SUB_B, SUB_C];
	const get = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation((path) =>
		path === "/api/subscriptions"
			? Promise.resolve(subscriptions)
			: (get?.(path) as Promise<unknown>),
	);
	renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(chip("游戏"));
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.click(manager.getByRole("button", { name: "删除 游戏" }));
	expect(manager.getByText(/订阅本身不会删除/)).toBeTruthy();
	fireEvent.click(manager.getByRole("button", { name: "标记删除" }));
	expect(manager.queryByRole("textbox", { name: "标签名称 3" })).toBeNull();
	fireEvent.click(manager.getByRole("button", { name: "撤销" }));
	expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	fireEvent.click(manager.getByRole("button", { name: "删除 游戏" }));
	fireEvent.click(manager.getByRole("button", { name: "标记删除" }));
	expect(api.put).not.toHaveBeenCalled();
	vi.mocked(api.put).mockImplementation(async () => {
		subscriptions = [SUB_A, { ...SUB_B, tagIds: [CHAT.id] }, SUB_C];
		return [CHAT, MUSIC];
	});
	await saveManager(manager);
	await waitFor(() =>
		expect(api.put).toHaveBeenCalledWith("/api/subscriptions/tags", [CHAT, MUSIC]),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(screen.getByText("UP甲")).toBeTruthy();
	expect(screen.getByText("UP乙")).toBeTruthy();
	expect(screen.getByText("UP丙")).toBeTruthy();
	expect(tagChips()).toEqual(["全部3", "杂谈2", "音乐0", "无标签1"]);
});

it("keeps the manager available for an empty table and creates an unused label only on save", async () => {
	const get = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation((path) =>
		path === "/api/subscriptions/tags" || path === "/api/subscriptions"
			? Promise.resolve([])
			: (get?.(path) as Promise<unknown>),
	);
	renderSubs();
	fireEvent.click(await screen.findByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	await manager.findByText(/还没有标签/);
	fireEvent.change(manager.getByRole("textbox", { name: "新标签名称" }), {
		target: { value: " 周末计划 " },
	});
	fireEvent.click(manager.getByRole("button", { name: "添加" }));
	expect(api.put).not.toHaveBeenCalled();
	vi.mocked(api.put).mockImplementation(async (_path, body) => body);
	await saveManager(manager);
	await waitFor(() =>
		expect(api.put).toHaveBeenCalledWith("/api/subscriptions/tags", [
			{ id: expect.stringMatching(/^[a-f0-9-]{36}$/), name: "周末计划" },
		]),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(tagChips()).toEqual(["全部0", "周末计划0"]);
});

it("preserves unsaved edits but blocks overwriting a registry update already received from elsewhere", async () => {
	const { qc } = renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: "本地修改" },
	});
	await waitFor(() =>
		expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	act(() =>
		qc.setQueryData(SUBSCRIPTION_TAGS_QUERY_KEY, [{ ...CHAT, name: "后台改名" }, GAME, MUSIC]),
	);
	await manager.findByText(/标签表已在其他位置更新/);
	expect((manager.getByRole("textbox", { name: "标签名称 2" }) as HTMLInputElement).value).toBe(
		"本地修改",
	);
	expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	fireEvent.click(manager.getByRole("button", { name: "重新载入并放弃修改" }));
	expect((manager.getByRole("textbox", { name: "标签名称 1" }) as HTMLInputElement).value).toBe(
		"后台改名",
	);
	expect((manager.getByRole("textbox", { name: "标签名称 2" }) as HTMLInputElement).value).toBe(
		"游戏",
	);
	expect(api.put).not.toHaveBeenCalled();
});

it("keeps the draft and local validation current when voice changes", async () => {
	renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.change(manager.getByRole("textbox", { name: "新标签名称" }), {
		target: { value: " 游戏 " },
	});
	fireEvent.click(manager.getByRole("button", { name: "添加" }));
	expect(manager.getByText("已有同名标签，请使用不同名称。")).toBeTruthy();
	act(() => i18n.set({ voice: "maid" }));
	expect(manager.getByText("主人，这个标签已经有了，换一个名称吧。")).toBeTruthy();
	expect((manager.getByRole("textbox", { name: "新标签名称" }) as HTMLInputElement).value).toBe(
		" 游戏 ",
	);
	expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
});

it("locks the in-flight save, preserves edits and request issues on failure, and can retry", async () => {
	renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: "新游戏" },
	});
	let reject!: (reason: unknown) => void;
	vi.mocked(api.put).mockImplementationOnce(
		() =>
			new Promise((_resolve, r) => {
				reject = r;
			}),
	);
	await saveManager(manager);
	await manager.findByRole("button", { name: "正在保存…" });
	expect((manager.getByRole("textbox", { name: "标签名称 2" }) as HTMLInputElement).disabled).toBe(
		true,
	);
	fireEvent.keyDown(window, { key: "Escape" });
	fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
	expect(screen.getByRole("dialog")).toBeTruthy();
	await act(async () =>
		reject(
			Object.assign(new Error("无法保存"), {
				issues: [{ path: [1, "name"], message: "名字冲突" }],
			}),
		),
	);
	await manager.findByText("无法保存：1.name：名字冲突");
	expect((manager.getByRole("textbox", { name: "标签名称 2" }) as HTMLInputElement).value).toBe(
		"新游戏",
	);
	vi.mocked(api.put).mockResolvedValueOnce([CHAT, { ...GAME, name: "新游戏" }, MUSIC]);
	await saveManager(manager);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(chip("新游戏")).toBeTruthy();
});

it("blocks a cached table after a read failure, then retries without losing the local draft", async () => {
	const { qc } = renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: "本地草稿" },
	});
	await waitFor(() =>
		expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	const get = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation((path) =>
		path === "/api/subscriptions/tags"
			? Promise.reject(new Error("offline"))
			: (get?.(path) as Promise<unknown>),
	);
	await act(async () => {
		await qc.invalidateQueries({ queryKey: SUBSCRIPTION_TAGS_QUERY_KEY });
	});
	await manager.findByText("标签表未能读出，不能覆盖保存。");
	expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	vi.mocked(api.get).mockImplementation((path) => get?.(path) as Promise<unknown>);
	fireEvent.click(manager.getByRole("button", { name: "重试" }));
	await manager.findByRole("textbox", { name: "标签名称 2" });
	expect((manager.getByRole("textbox", { name: "标签名称 2" }) as HTMLInputElement).value).toBe(
		"本地草稿",
	);
	expect(api.put).not.toHaveBeenCalled();
});

it("validates empty and duplicate names and confirms discard including an unadded name", async () => {
	renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: " " },
	});
	expect(manager.getByText("名称不能为空。")).toBeTruthy();
	expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: "杂谈" },
	});
	expect(manager.getAllByText("与其他标签重名。")).toHaveLength(2);
	fireEvent.change(manager.getByRole("textbox", { name: "标签名称 2" }), {
		target: { value: "游戏" },
	});
	fireEvent.change(manager.getByRole("textbox", { name: "新标签名称" }), {
		target: { value: "还没添加" },
	});
	fireEvent.keyDown(window, { key: "Escape" });
	expect(manager.getByText(/放弃未保存的标签修改/)).toBeTruthy();
	fireEvent.click(manager.getByRole("button", { name: "继续编辑" }));
	expect((manager.getByRole("textbox", { name: "新标签名称" }) as HTMLInputElement).value).toBe(
		"还没添加",
	);
	fireEvent.click(manager.getByRole("button", { name: "取消" }));
	fireEvent.click(manager.getByRole("button", { name: "放弃修改" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(api.put).not.toHaveBeenCalled();
});

it("undoes multiple staged deletions without reversing their registry order", async () => {
	renderSubs();
	await screen.findByText("无标签");
	fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
	const manager = within(screen.getByRole("dialog"));
	for (const name of ["杂谈", "游戏"]) {
		fireEvent.click(manager.getByRole("button", { name: `删除 ${name}` }));
		fireEvent.click(manager.getByRole("button", { name: "标记删除" }));
	}
	fireEvent.click(manager.getAllByRole("button", { name: "撤销" })[0]);
	fireEvent.click(manager.getByRole("button", { name: "撤销" }));
	expect(
		[1, 2, 3].map(
			(index) =>
				(manager.getByRole("textbox", { name: `标签名称 ${index}` }) as HTMLInputElement).value,
		),
	).toEqual(["杂谈", "游戏", "音乐"]);
	expect((manager.getByRole("button", { name: "保存更改" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
});

it("keeps keyboard focus in the manager and restores its entry when closed", async () => {
	renderSubs();
	await screen.findByText("无标签");
	const entry = screen.getByRole("button", { name: "管理标签" });
	entry.focus();
	fireEvent.click(entry);
	const manager = within(screen.getByRole("dialog"));
	const first = manager.getByRole("textbox", { name: "新标签名称" });
	await waitFor(() => expect(document.activeElement).toBe(first));
	fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
	expect(document.activeElement).toBe(manager.getByRole("button", { name: "取消" }));
	fireEvent.keyDown(window, { key: "Tab" });
	expect(document.activeElement).toBe(first);
	fireEvent.click(manager.getByRole("button", { name: "取消" }));
	expect(document.activeElement).toBe(entry);
});
