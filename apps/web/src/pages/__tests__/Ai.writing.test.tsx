// @vitest-environment jsdom
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { adapterKeyFor, snapshotFor } from "../../__tests__/platform-snapshot";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import type { Connection, PushTarget } from "../../types/domain";
import Ai from "../Ai";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const GROUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIVATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENDPOINT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DELETED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const connections: Connection[] = [
	{
		id: CONNECTION,
		name: "家庭机器人",
		adapterKey: adapterKeyFor("onebot"),
		platform: "onebot",
		enabled: true,
		settings: {},
		platformSnapshot: snapshotFor("onebot"),
	},
];
const targets: PushTarget[] = [
	{
		id: GROUP,
		name: "读书会",
		connectionId: CONNECTION,
		kind: "session",
		scope: "group",
		address: "1",
		enabled: true,
	},
	{
		id: PRIVATE,
		name: "主人私聊",
		connectionId: CONNECTION,
		kind: "session",
		scope: "private",
		address: "2",
		enabled: true,
	},
	{ id: ENDPOINT, name: "工作室通知", connectionId: CONNECTION, kind: "endpoint", enabled: false },
];
function mount(config = makeDefaultGlobalSettings()) {
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/targets") return targets;
		if (path === "/api/connections") return connections;
		return { core: structuredClone(config) };
	});
	vi.mocked(api.patch).mockResolvedValue({ core: structuredClone(config) });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<MemoryRouter>
			<QueryClientProvider client={client}>
				<Ai />
			</QueryClientProvider>
		</MemoryRouter>,
	);
	return config;
}
const card = () => within(screen.getByRole("region", { name: "女仆写正文" }));
const defaultRow = () => within(card().getByRole("group", { name: "默认正文" }));
const row = (name: string) =>
	within(card().getByRole("group", { name: new RegExp(`^${name} · `) }));
const open = async () => fireEvent.click(await card().findByRole("button", { name: "展开例外" }));
const save = () =>
	act(async () => {
		await useDraftStore.getState().current?.onSave();
	});
beforeEach(() => {
	vi.clearAllMocks();
	i18n.set({ locale: "zh-CN", voice: "plain" });
	useDraftStore.setState({ current: null, uiState: "idle", errorMessage: null });
});
afterEach(cleanup);

it("localized writing controls keep the selected scene and staged target override", async () => {
	const config = makeDefaultGlobalSettings();
	config.ai.writing.liveSummary.byTarget = { [DELETED]: true };
	mount(config);
	await screen.findByRole("region", { name: "女仆写正文" });
	fireEvent.click(card().getByRole("button", { name: "直播总结" }));
	await open();
	fireEvent.click(row("读书会").getByRole("button", { name: "模板" }));
	for (const [locale, title, scene, template, counts] of [
		["en", "AI-written body", "Live summary", "Template", "3 targets · 1 explicit override"],
		["ja", "AI による本文", "配信要約", "テンプレート", "送信先 3 件 · 個別設定 1 件"],
		["zh-TW", "女僕撰寫內文", "直播摘要", "範本", "3 個目標 · 1 筆明確例外"],
	] as const) {
		act(() => i18n.set({ locale }));
		const region = within(screen.getByRole("region", { name: title }));
		expect(region.getByText(counts)).toBeTruthy();
		expect(region.getByRole("button", { name: scene }).getAttribute("aria-pressed")).toBe("true");
		expect(
			within(region.getByRole("group", { name: /^读书会 · / }))
				.getByRole("button", { name: template })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	}
	expect(screen.getByText("有 1 筆例外的目標已不存在，目前不會套用；設定仍會保留。")).toBeTruthy();
	await save();
	expect(api.patch).toHaveBeenCalledOnce();
	expect(vi.mocked(api.patch).mock.calls[0]?.[1]).toMatchObject({
		core: {
			ai: { writing: { liveSummary: { byTarget: { [GROUP]: false, [DELETED]: true } } } },
		},
	});
});

it("edits the default body through the existing AI draft and settings request", async () => {
	mount();
	await screen.findByRole("region", { name: "女仆写正文" });
	expect(defaultRow().getByRole("button", { name: "AI 写" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	fireEvent.click(defaultRow().getByRole("button", { name: "模板" }));
	await waitFor(() =>
		expect(useDraftStore.getState().current?.diff).toContainEqual({
			code: "ai.writing.post.isOnByDefault",
			oldValue: true,
			newValue: false,
		}),
	);
	await save();
	expect(api.patch).toHaveBeenCalledWith(
		"/api/settings",
		expect.objectContaining({
			core: expect.objectContaining({
				ai: expect.objectContaining({
					writing: {
						post: { isOnByDefault: false, byTarget: {} },
						liveSummary: { isOnByDefault: true, byTarget: {} },
					},
				}),
			}),
		}),
	);
});

it("keeps scenes and explicit same-default choices independent across AI tabs; discard restores both", async () => {
	const config = makeDefaultGlobalSettings();
	config.ai.enabled = true;
	config.ai.writing.post.byTarget = { [PRIVATE]: false, [DELETED]: true };
	mount(config);
	await screen.findByRole("region", { name: "女仆写正文" });
	await open();
	expect(row("主人私聊").getByRole("button", { name: "模板" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(row("工作室通知").getByText("已停用")).toBeTruthy();
	fireEvent.click(row("读书会").getByRole("button", { name: "AI 写" }));
	fireEvent.click(defaultRow().getByRole("button", { name: "模板" }));
	expect(row("读书会").getByRole("button", { name: "AI 写" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(
		row("工作室通知")
			.getByRole("button", { name: "跟随默认（模板）" })
			.getAttribute("aria-pressed"),
	).toBe("true");
	fireEvent.click(card().getByRole("button", { name: "直播总结" }));
	expect(defaultRow().getByRole("button", { name: "AI 写" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	fireEvent.click(defaultRow().getByRole("button", { name: "模板" }));
	fireEvent.click(screen.getByRole("tab", { name: /模型配置/ }));
	fireEvent.click(screen.getByRole("tab", { name: /全局配置/ }));
	expect(defaultRow().getByRole("button", { name: "模板" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	await waitFor(() => expect(useDraftStore.getState().current?.diff.length).toBeGreaterThan(0));
	act(() => useDraftStore.getState().current?.onDiscard());
	expect(defaultRow().getByRole("button", { name: "AI 写" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	await waitFor(() => expect(useDraftStore.getState().current?.diff).toHaveLength(0));
	expect(api.patch).not.toHaveBeenCalled();
});

it("inherit sends null, false survives, deleted target preferences survive unrelated saves", async () => {
	const config = makeDefaultGlobalSettings();
	config.ai.writing.post.byTarget = { [PRIVATE]: false, [DELETED]: true };
	mount(config);
	await screen.findByRole("region", { name: "女仆写正文" });
	await open();
	fireEvent.click(row("主人私聊").getByRole("button", { name: "跟随默认（AI 写）" }));
	fireEvent.click(row("工作室通知").getByRole("button", { name: "模板" }));
	await waitFor(() => expect(useDraftStore.getState().current?.diff.length).toBeGreaterThan(0));
	await save();
	const body = vi.mocked(api.patch).mock.calls.at(-1)?.[1];
	expect(body).toMatchObject({
		core: {
			ai: {
				writing: { post: { byTarget: { [PRIVATE]: null, [ENDPOINT]: false, [DELETED]: true } } },
			},
		},
	});
});

it("failed save keeps edits for retry, successful response becomes the saved baseline", async () => {
	const config = makeDefaultGlobalSettings();
	mount(config);
	await screen.findByRole("region", { name: "女仆写正文" });
	fireEvent.click(defaultRow().getByRole("button", { name: "模板" }));
	await waitFor(() => expect(useDraftStore.getState().current?.diff.length).toBeGreaterThan(0));
	vi.mocked(api.patch).mockRejectedValueOnce(new Error("保存失败"));
	await save();
	expect(useDraftStore.getState().uiState).toBe("error");
	expect(defaultRow().getByRole("button", { name: "模板" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
	config.ai.writing.post.isOnByDefault = false;
	vi.mocked(api.patch).mockResolvedValueOnce({ core: structuredClone(config) });
	await save();
	await waitFor(() => expect(useDraftStore.getState().current?.diff).toHaveLength(0));
});

it("reads failures honestly and retries without dropping the default or touching hidden exceptions", async () => {
	const config = makeDefaultGlobalSettings();
	config.ai.writing.post.byTarget = { [DELETED]: true };
	mount(config);
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/targets") throw new Error("offline");
		return path === "/api/connections" ? connections : { core: structuredClone(config) };
	});
	await screen.findByText("推送目标或连接未能读出，暂时不显示例外表。");
	expect(card().queryByRole("button", { name: "展开例外" })).toBeNull();
	fireEvent.click(defaultRow().getByRole("button", { name: "模板" }));
	vi.mocked(api.get).mockImplementation(async (path) =>
		path === "/api/targets"
			? targets
			: path === "/api/connections"
				? connections
				: { core: structuredClone(config) },
	);
	fireEvent.click(card().getByRole("button", { name: "重试" }));
	await card().findByRole("button", { name: "展开例外" });
	await open();
	expect(
		row("读书会").getByRole("button", { name: "跟随默认（模板）" }).getAttribute("aria-pressed"),
	).toBe("true");
});

it("has an editable default without targets; changing voice preserves draft and controls", async () => {
	mount();
	vi.mocked(api.get).mockImplementation(async (path) =>
		path === "/api/targets" || path === "/api/connections"
			? []
			: { core: makeDefaultGlobalSettings() },
	);
	await screen.findByText("还没有推送目标。默认正文可以先设置，添加目标后再单独指定例外。");
	fireEvent.click(defaultRow().getByRole("button", { name: "模板" }));
	act(() => i18n.set({ voice: "maid" }));
	expect(screen.getByText(/主人，还没有推送目标/)).toBeTruthy();
	expect(defaultRow().getByRole("button", { name: "模板" }).getAttribute("aria-pressed")).toBe(
		"true",
	);
});
