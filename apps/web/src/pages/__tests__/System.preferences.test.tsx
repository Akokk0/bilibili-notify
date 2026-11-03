// @vitest-environment jsdom

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useTextSettings } from "../../i18n/use-text-settings";
import { useDraftStore } from "../../store/draft";
import type { GlobalConfig } from "../../types/globals";
import System from "../System";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));
vi.mock("../skins/SkinSection", () => ({ SkinSection: () => <div data-testid="skin-section" /> }));

import { api } from "../../services/api";

function SettingsShell() {
	useTextSettings();
	return <System />;
}

async function renderAppearance(overrides: Partial<GlobalConfig> = {}) {
	const settings = {
		core: { ...makeDefaultGlobalConfig(), locale: "zh-CN" as const, ...overrides },
		bilibili: { dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 },
	};
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/settings") return structuredClone(settings);
		if (path === "/api/sources/bilibili/auth") return { state: { status: "logged-out" } };
		if (path === "/api/connections/capabilities") return {};
		return [];
	});
	vi.mocked(api.patch).mockImplementation(async (_path, patch) => {
		const core = settings.core as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries((patch as { core: object }).core)) {
			if (value === null) delete core[key];
			else core[key] = value;
		}
		return structuredClone(settings);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<MemoryRouter initialEntries={["/system"]}>
			<QueryClientProvider client={qc}>
				<SettingsShell />
			</QueryClientProvider>
		</MemoryRouter>,
	);
	await screen.findByText("主人账号");
	fireEvent.click(screen.getAllByRole("button", { name: "外观" })[0]);
	await screen.findByRole("group", { name: "界面语言" });
}

beforeEach(() => {
	localStorage.clear();
	i18n.set({ locale: "zh-CN", voice: "plain" });
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.resetAllMocks();
});
afterEach(() => {
	cleanup();
	i18n.set({ locale: "zh-CN", voice: "maid" });
});

describe("系统外观的语言、口吻和时区", () => {
	it("切到无女仆层的语言只隐藏口吻，切回来保留原选项；放弃跨区草稿不改变已应用设置", async () => {
		await renderAppearance({ voice: "plain" });
		fireEvent.click(
			within(screen.getByRole("group", { name: "界面语言" })).getByRole("button", {
				name: "日本語",
			}),
		);
		expect(screen.queryByRole("group", { name: "文案口吻" })).toBeNull();
		expect(i18n.state().locale).toBe("zh-CN");
		fireEvent.click(
			within(screen.getByRole("group", { name: "界面语言" })).getByRole("button", {
				name: "简体中文",
			}),
		);
		expect(
			within(screen.getByRole("group", { name: "文案口吻" }))
				.getByRole("button", { name: "平实" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		fireEvent.change(screen.getByRole("textbox", { name: "时区" }), {
			target: { value: "Asia/Calcutta" },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "账号" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "外观" })[0]);
		expect((screen.getByRole("textbox", { name: "时区" }) as HTMLInputElement).value).toBe(
			"Asia/Calcutta",
		);
		act(() => useDraftStore.getState().current?.onDiscard());
		expect((screen.getByRole("textbox", { name: "时区" }) as HTMLInputElement).value).toBe(
			"Asia/Shanghai",
		);
		expect(api.patch).not.toHaveBeenCalled();
		expect(i18n.state().voice).toBe("plain");
	});

	it("保存只发改动字段，成功后语言与浏览器偏好跟上，隐藏口吻不被改写", async () => {
		await renderAppearance({ voice: "maid" });
		fireEvent.click(
			within(screen.getByRole("group", { name: "界面语言" })).getByRole("button", {
				name: "English",
			}),
		);
		fireEvent.change(screen.getByRole("textbox", { name: "时区" }), {
			target: { value: "America/New_York" },
		});
		expect(i18n.state().locale).toBe("zh-CN");
		expect(localStorage.getItem("bn.locale")).toBe("zh-CN");
		await waitFor(() => expect(useDraftStore.getState().current?.diff).toHaveLength(2));
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenCalledWith("/api/settings", {
			core: { locale: "en", timezone: "America/New_York" },
		});
		await waitFor(() => expect(i18n.state().locale).toBe("en"));
		expect(i18n.state().voice).toBe("plain");
		expect(localStorage.getItem("bn.locale")).toBe("en");
		expect(screen.queryByRole("group", { name: "文案口吻" })).toBeNull();
		fireEvent.click(
			within(screen.getByRole("group", { name: "界面语言" })).getByRole("button", {
				name: "简体中文",
			}),
		);
		expect(
			within(screen.getByRole("group", { name: "文案口吻" }))
				.getByRole("button", { name: "女仆" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenLastCalledWith("/api/settings", { core: { locale: "zh-CN" } });
		await waitFor(() => expect(i18n.state().voice).toBe("maid"));
	});

	it("恢复默认口吻提交显式null，成功后回到默认女仆并记入浏览器", async () => {
		await renderAppearance({ voice: "plain" });
		fireEvent.click(
			within(screen.getByRole("group", { name: "文案口吻" })).getByRole("button", {
				name: "跟随默认（女仆）",
			}),
		);
		expect(i18n.state().voice).toBe("plain");
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(api.patch).toHaveBeenCalledWith("/api/settings", { core: { voice: null } });
		await waitFor(() => expect(i18n.state().voice).toBe("maid"));
		expect(localStorage.getItem("bn.voice")).toBe("maid");
	});

	it("保存被拒时保留草稿与已应用语言口吻，显示服务端原因后可放弃", async () => {
		await renderAppearance({ voice: "plain" });
		fireEvent.click(
			within(screen.getByRole("group", { name: "文案口吻" })).getByRole("button", { name: "女仆" }),
		);
		fireEvent.change(screen.getByRole("textbox", { name: "时区" }), {
			target: { value: "+08:00" },
		});
		vi.mocked(api.patch).mockRejectedValueOnce(new Error("时区必须是有效的 IANA 名称"));
		await act(async () => {
			await useDraftStore.getState().current?.onSave();
		});
		expect(useDraftStore.getState().errorMessage).toContain("时区必须是有效的 IANA 名称");
		expect(i18n.state().voice).toBe("plain");
		expect(localStorage.getItem("bn.voice")).toBe("plain");
		expect((screen.getByRole("textbox", { name: "时区" }) as HTMLInputElement).value).toBe(
			"+08:00",
		);
		act(() => useDraftStore.getState().current?.onDiscard());
		expect((screen.getByRole("textbox", { name: "时区" }) as HTMLInputElement).value).toBe(
			"Asia/Shanghai",
		);
	});

	it("显示四种语言，未设口吻跟随默认女仆，只展示默认不回写", async () => {
		await renderAppearance();
		const languages = screen.getByRole("group", { name: "界面语言" });
		for (const name of ["简体中文", "繁體中文", "English", "日本語"])
			expect(within(languages).getByRole("button", { name })).toBeTruthy();
		const voices = screen.getByRole("group", { name: "文案口吻" });
		expect(
			within(voices).getByRole("button", { name: "跟随默认（女仆）" }).getAttribute("aria-pressed"),
		).toBe("true");
		expect((screen.getByRole("textbox", { name: "时区" }) as HTMLInputElement).value).toBe(
			"Asia/Shanghai",
		);
		expect(screen.getByTestId("skin-section")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	});
});
