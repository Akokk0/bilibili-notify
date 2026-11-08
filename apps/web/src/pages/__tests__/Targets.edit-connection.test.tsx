// @vitest-environment jsdom
import { i18n } from "../../i18n";
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";

/**
 * 推送目标建好之后焊死在它那条连接上:编辑弹窗里「选择连接」换成只读的「所属连接」,
 * 新建照旧能选。服务端另有守卫(config store),这里钉的是面板不再给出换连接的入口。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import type { Connection, PushTarget } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const HOME_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function onebot(id: string, name: string): Connection {
	return {
		id,
		name,
		enabled: true,
		adapterKey: "onebot",
		platform: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		settings: { transport: "http", baseUrl: "http://127.0.0.1:5700", accessToken: "" },
	} as unknown as Connection;
}

const TARGET = {
	id: "44444444-4444-4444-8444-444444444444",
	name: "游戏交流群",
	connectionId: HOME_ID,
	kind: "session",
	scope: "group",
	enabled: true,
	address: "10001",
} as unknown as PushTarget;

function renderPage() {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return { adapters: builtinAdapters };
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/connections")
			return [onebot(HOME_ID, "家里那台"), onebot(OTHER_ID, "备用那台")];
		if (url === "/api/targets") return [TARGET];
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Targets />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("目标弹窗的连接栏", () => {
	it("编辑已有目标:只读显示所属连接,没有可点的别的连接", async () => {
		renderPage();
		await screen.findByText("游戏交流群");
		const edit = await screen.findAllByRole("button", { name: "配置" });
		// 目标卡上的「配置」是最后一颗(连接卡的在前)。
		fireEvent.click(edit[edit.length - 1] as HTMLElement);
		const dialog = await waitFor(() => screen.getByRole("dialog"));
		expect(within(dialog).getByText("所属连接")).toBeTruthy();
		expect(within(dialog).queryByText("选择连接")).toBeNull();
		expect(within(dialog).getByText("家里那台")).toBeTruthy();
		expect(within(dialog).queryByText("备用那台")).toBeNull();
		expect(within(dialog).queryByText("已选")).toBeNull();
		// 连接栏里没有按钮(只读的 div)。
		expect(within(dialog).queryByRole("button", { name: /家里那台|备用那台/ })).toBeNull();
		expect(within(dialog).getByText(/目标建好之后不能换连接/)).toBeTruthy();
	});

	it("新建:照旧能在连接里选", async () => {
		renderPage();
		const add = await screen.findAllByRole("button", { name: /新建推送目标/ });
		fireEvent.click(add[0] as HTMLElement);
		const dialog = await waitFor(() => screen.getByRole("dialog"));
		expect(within(dialog).getByText("选择连接")).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: /家里那台/ })).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: /备用那台/ })).toBeTruthy();
	});
});

// These scenarios assert Chinese UI labels explicitly.
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

it("target editor translations preserve the original connection, edited name and session address until explicit save", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	renderPage();
	await screen.findByText("游戏交流群");
	const edit = await screen.findAllByRole("button", { name: "Configure" });
	const lastEdit = edit.at(-1);
	if (!lastEdit) throw new Error("Target configuration button missing");
	fireEvent.click(lastEdit);
	const dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByText("Configure push target")).toBeTruthy();
	const name = within(dialog).getByDisplayValue("游戏交流群");
	const address = within(dialog).getByDisplayValue("10001");
	fireEvent.change(name, { target: { value: "新群名称" } });
	fireEvent.change(address, { target: { value: "20002" } });
	for (const [locale, title, owner, scope, save] of [
		["ja", "送信先の設定", "所属する接続", "セッション種別", "保存"],
		["zh-TW", "設定推播目標", "所屬連線", "會話類型", "儲存"],
		["en", "Configure push target", "Connection", "Session type", "Save"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(within(dialog).getByText(title)).toBeTruthy();
		expect(within(dialog).getByText(owner)).toBeTruthy();
		expect(within(dialog).getByText(scope)).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: save })).toBeTruthy();
		expect(within(dialog).getByDisplayValue("新群名称")).toBe(name);
		expect(within(dialog).getByDisplayValue("20002")).toBe(address);
		expect(within(dialog).getByText("家里那台")).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: /备用那台/ })).toBeNull();
		expect(api.post).not.toHaveBeenCalled();
	}
	vi.mocked(api.post).mockResolvedValueOnce([]);
	fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
	await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
	expect(api.post).toHaveBeenCalledWith("/api/targets", {
		...TARGET,
		name: "新群名称",
		address: "20002",
	});
	await screen.findByText("Target saved");
	for (const [locale, message] of [
		["ja", "送信先を保存しました"],
		["zh-TW", "目標已儲存"],
		["en", "Target saved"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByText(message)).toBeTruthy();
		expect(api.post).toHaveBeenCalledOnce();
	}
});
