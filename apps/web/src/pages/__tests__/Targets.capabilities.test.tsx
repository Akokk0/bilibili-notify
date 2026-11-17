// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import { PlatformMetaRoot } from "../../components/platform-meta";
import { i18n } from "../../i18n";
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const PRIVATE_ID = "33333333-3333-4333-8333-333333333333";
const checkedAt = "2026-11-17T00:00:00.000Z";
const connection = {
	id: CONNECTION_ID,
	name: "机器人甲",
	adapterKey: "qq-official",
	platform: "qq-official",
	platformSnapshot: snapshotFor("qq-official"),
	enabled: true,
	settings: { appId: "app", appSecret: { masked: "***" }, botType: "public", sandbox: false },
};
const group = {
	id: GROUP_ID,
	name: "群甲",
	connectionId: CONNECTION_ID,
	kind: "session",
	scope: "group",
	address: "GROUP1",
	enabled: true,
};
const personal = { ...group, id: PRIVATE_ID, name: "私聊甲", scope: "private", address: "USER1" };
const capabilities = {
	atAll: { state: "supported", checkedAt },
	nativeShare: { state: "unknown" },
	inbound: { state: "supported", checkedAt },
	image: { state: "supported", checkedAt },
	audio: { state: "unsupported", reason: "BN 尚未接入语音发送", checkedAt },
};

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.mocked(api.get).mockImplementation(async (url) => {
		if (url === "/api/adapters")
			return {
				adapters: builtinAdapters.map((entry) => ({
					...entry,
					has: { ...entry.has, fetchDestinationStatus: entry.key === "qq-official" },
				})),
			};
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/connections") return [connection];
		if (url.startsWith(`/api/connections/${CONNECTION_ID}/addresses?`)) return { candidates: [] };
		if (url === "/api/targets") return [group, personal];
		if (url === "/api/connections/capabilities") return { [CONNECTION_ID]: capabilities };
		if (url === `/api/targets/${GROUP_ID}/status`)
			return {
				status: {
					role: { state: "known", value: "admin", checkedAt },
					atAllUsage: {
						state: "not-recorded",
						date: "2026-11-17",
						timezone: "Asia/Shanghai",
						source: "bn",
					},
				},
			};
		return [];
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<PlatformMetaRoot>
				<Targets />
			</PlatformMetaRoot>
		</QueryClientProvider>,
	);
}

it("机器人能力属于连接,群内身份与用量属于群目标,私聊不查群状态", async () => {
	renderPage();
	const list = await screen.findByRole("list", { name: "机器人能力" });
	expect(await within(list).findByLabelText("艾特全体：支持")).toBeTruthy();
	expect(within(list).getByLabelText("原生分享卡：还不知道")).toBeTruthy();
	expect(within(list).getByLabelText("语音：不支持")).toBeTruthy();
	expect(within(list).getByLabelText("Markdown：还不知道")).toBeTruthy();
	const status = await screen.findByRole("region", { name: "群甲 · 群内状态" });
	expect(await within(status).findByText("管理员")).toBeTruthy();
	expect(within(status).getByText("今日未记录使用")).toBeTruthy();
	expect(within(status).queryByText(/剩余 1/)).toBeNull();
	expect(screen.queryByRole("region", { name: "私聊甲 · 群内状态" })).toBeNull();
	expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).not.toContain(
		`/api/targets/${PRIVATE_ID}/status`,
	);
	expect(api.post).not.toHaveBeenCalled();
});

it("目标小卡独立命名,状态和配置操作始终归属对应目标", async () => {
	renderPage();
	const groupCard = await screen.findByRole("article", { name: "群甲" });
	const privateCard = screen.getByRole("article", { name: "私聊甲" });
	expect(await within(groupCard).findByText("管理员")).toBeTruthy();
	expect(within(privateCard).queryByRole("region")).toBeNull();
	fireEvent.click(within(privateCard).getByRole("button", { name: "配置" }));
	expect(await screen.findByDisplayValue("私聊甲")).toBeTruthy();
	expect(api.post).not.toHaveBeenCalled();
	expect(api.patch).not.toHaveBeenCalled();
});

it("群内状态失败显示未知,刷新只读并在成功后显示真实记录", async () => {
	const original = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation(async (url) => {
		if (url === `/api/targets/${GROUP_ID}/status`) throw new Error("连接暂时中断");
		if (url === `/api/targets/${GROUP_ID}/status?refresh=1`)
			return {
				status: {
					role: { state: "known", value: "owner", checkedAt },
					atAllUsage: {
						state: "used",
						date: "2026-11-17",
						timezone: "Asia/Shanghai",
						source: "bn",
					},
				},
			};
		return original?.(url);
	});
	renderPage();
	const panel = await screen.findByRole("region", { name: "群甲 · 群内状态" });
	expect(await within(panel).findByText(/连接暂时中断/)).toBeTruthy();
	expect(within(panel).getByText("未知")).toBeTruthy();
	fireEvent.click(within(panel).getByRole("button", { name: "刷新群甲的群内状态" }));
	expect(await within(panel).findByText("群主")).toBeTruthy();
	expect(within(panel).getByText("今日已使用")).toBeTruthy();
	expect(api.get).toHaveBeenCalledWith(`/api/targets/${GROUP_ID}/status?refresh=1`);
	expect(api.post).not.toHaveBeenCalled();
});

it("刷新失败时旧记录标出原日期,不冒充今日状态", async () => {
	const original = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation(async (url) => {
		if (url.endsWith("?refresh=1")) throw new Error("离线");
		return original?.(url);
	});
	renderPage();
	const panel = await screen.findByRole("region", { name: "群甲 · 群内状态" });
	await within(panel).findByText("今日未记录使用");
	fireEvent.click(within(panel).getByRole("button", { name: "刷新群甲的群内状态" }));
	await within(panel).findByText(/离线/);
	expect(within(panel).getByText("上次记录（2026-11-17）")).toBeTruthy();
	expect(within(panel).queryByText("今日未记录使用")).toBeNull();
});

it("停用群目标不请求状态,旧适配器缺项保持未知", async () => {
	const original = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation(async (url) => {
		if (url === "/api/targets") return [{ ...group, enabled: false }];
		if (url === "/api/connections/capabilities")
			return {
				[CONNECTION_ID]: {
					atAll: { state: "unknown" },
					inbound: { state: "unknown" },
					nativeShare: { state: "unknown" },
				},
			};
		return original?.(url);
	});
	renderPage();
	const panel = await screen.findByRole("region", { name: "群甲 · 群内状态" });
	expect(within(panel).getByText("目标或连接已停用")).toBeTruthy();
	expect(
		within(panel).getByRole("button", { name: "刷新群甲的群内状态" }).hasAttribute("disabled"),
	).toBe(true);
	expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).not.toContain(
		`/api/targets/${GROUP_ID}/status`,
	);
	const list = await screen.findByRole("list", { name: "机器人能力" });
	expect(within(list).getByLabelText("图片：还不知道")).toBeTruthy();
});

it("四语切换更新能力与群角色文案,不改变名字和记录", async () => {
	renderPage();
	await screen.findByText("今日未记录使用");
	for (const [locale, title, admin, unused] of [
		["en", "Bot capabilities", "Administrator", "No use recorded today"],
		["ja", "ボットの機能", "管理者", "今日の使用記録なし"],
		["zh-TW", "機器人能力", "管理員", "今日未記錄使用"],
		["zh-CN", "机器人能力", "管理员", "今日未记录使用"],
	] as const) {
		act(() => i18n.set({ locale }));
		expect(screen.getByRole("list", { name: title })).toBeTruthy();
		expect(screen.getByText(admin)).toBeTruthy();
		expect(screen.getByText(unused)).toBeTruthy();
		expect(screen.getAllByText("机器人甲").length).toBeGreaterThan(0);
	}
	expect(api.patch).not.toHaveBeenCalled();
	expect(api.post).not.toHaveBeenCalled();
});

it("连接探测确认新能力后立即刷新能力表", async () => {
	let probed = false;
	const original = vi.mocked(api.get).getMockImplementation();
	vi.mocked(api.get).mockImplementation(async (url) => {
		if (url === "/api/connections/capabilities")
			return {
				[CONNECTION_ID]: {
					...capabilities,
					nativeShare: probed ? { state: "supported", checkedAt } : { state: "unknown" },
				},
			};
		return original?.(url);
	});
	vi.mocked(api.post).mockImplementationOnce(async () => {
		probed = true;
		return { ok: true, latencyMs: 12 };
	});
	renderPage();
	const list = await screen.findByRole("list", { name: "机器人能力" });
	await within(list).findByLabelText("艾特全体：支持");
	expect(within(list).getByLabelText("原生分享卡：还不知道")).toBeTruthy();
	const header = screen.getByRole("region", { name: "机器人甲" });
	fireEvent.click(within(header).getByRole("button", { name: "测试" }));
	expect(await within(list).findByLabelText("原生分享卡：支持")).toBeTruthy();
});
