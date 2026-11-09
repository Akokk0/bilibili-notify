// @vitest-environment jsdom

import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import { useSessionStore } from "../../store/session";
import System from "../System";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
	ApiError: class extends Error {},
}));
vi.mock("../../utils/externalLink", () => ({ isDesktop: vi.fn(() => false) }));

import { api } from "../../services/api";
import { isDesktop } from "../../utils/externalLink";

function renderSystem() {
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/settings")
			return {
				core: makeDefaultGlobalSettings(),
				bilibili: { dynamicCron: "30 */2 * * * *", healthCheckMinutes: 30 },
			};
		if (path === "/api/sources/bilibili/auth") return { state: { status: "logged-out" } };
		if (path === "/api/connections/capabilities") return {};
		return [];
	});
	return render(
		<MemoryRouter>
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<System />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	useSessionStore.setState({ hydrated: true, authRequired: true, authed: true, expired: false });
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	vi.resetAllMocks();
	vi.mocked(isDesktop).mockReturnValue(false);
});
afterEach(() => {
	cleanup();
	useSessionStore.setState({ hydrated: false, authRequired: false, authed: false, expired: false });
});

describe("系统页面板账号凭据", () => {
	it.each([
		[
			"ja",
			"新しいユーザー名",
			"保存して再ログイン",
			"ご主人様、ユーザー名とパスワードの全項目を入力してくださいね。",
			"ユーザー名とパスワードの全項目を入力してください。",
		],
		[
			"zh-TW",
			"新帳號",
			"儲存並重新登入",
			"主人，請把帳號和密碼填完整喔。",
			"請完整填寫帳號與密碼欄位。",
		],
	] as const)(
		"%s：切换女仆口吻保留账号输入，校验现取口吻且不提交",
		async (locale, account, save, maid, plain) => {
			renderSystem();
			fireEvent.click(await screen.findByRole("button", { name: "修改账号密码" }));
			const username = screen.getByLabelText("新账号");
			fireEvent.change(username, { target: { value: "Original 账号 {name}" } });
			for (const [voice, expected] of [
				["maid", maid],
				["plain", plain],
			] as const) {
				await act(async () => i18n.set({ locale, voice }));
				expect(screen.getByLabelText(account)).toBe(username);
				expect(username).toHaveProperty("value", "Original 账号 {name}");
				fireEvent.click(screen.getByRole("button", { name: save }));
				expect(await screen.findByRole("alert")).toHaveProperty("textContent", expected);
				expect(api.put).not.toHaveBeenCalled();
				expect(useSessionStore.getState().authed).toBe(true);
			}
		},
	);

	it("credential labels and new validation follow language while the entered account stays unchanged", async () => {
		renderSystem();
		fireEvent.click(await screen.findByRole("button", { name: "修改账号密码" }));
		const username = screen.getByLabelText("新账号");
		fireEvent.change(username, { target: { value: "原样名字" } });
		for (const [locale, account, save, required] of [
			["en", "New username", "Save and sign in again", "Fill in all account and password fields."],
			[
				"ja",
				"新しいユーザー名",
				"保存して再ログイン",
				"ユーザー名とパスワードの全項目を入力してください。",
			],
			["zh-TW", "新帳號", "儲存並重新登入", "請完整填寫帳號與密碼欄位。"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(screen.getByLabelText(account)).toBe(username);
			expect(username).toHaveProperty("value", "原样名字");
			fireEvent.click(screen.getByRole("button", { name: save }));
			expect(await screen.findByRole("alert")).toHaveProperty("textContent", required);
			expect(api.put).not.toHaveBeenCalled();
			expect(useSessionStore.getState().authed).toBe(true);
		}
	});

	it("有未保存系统草稿时先要求保存或放弃，不直接改密丢失草稿", async () => {
		renderSystem();
		await screen.findByText("主人账号");
		fireEvent.click(screen.getAllByRole("button", { name: "运行" })[0]);
		const core = await screen.findByRole("group", { name: "核心（core）日志等级" });
		fireEvent.click(within(core).getByRole("button", { name: "L4 · 调试" }));
		fireEvent.click(screen.getAllByRole("button", { name: "账号" })[0]);
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "修改账号密码" }) as HTMLButtonElement).disabled,
			).toBe(true),
		);
		expect(screen.getByText("请先保存或放弃系统设置，再修改账号密码。")).toBeTruthy();
		expect(api.put).not.toHaveBeenCalled();
	});

	it.each([
		[false, false, true, true],
		[true, true, true, true],
		[false, true, false, true],
		[false, true, true, false],
	])(
		"desktop=%s required=%s authed=%s hydrated=%s时不露入口",
		async (desktop, authRequired, authed, hydrated) => {
			vi.mocked(isDesktop).mockReturnValue(desktop);
			useSessionStore.setState({ authRequired, authed, hydrated });
			renderSystem();
			await screen.findByText("主人账号");
			expect(screen.queryByRole("button", { name: "修改账号密码" })).toBeNull();
		},
	);

	it.each(["当前密码不正确", "此部署由环境变量管理，不能在面板修改"])(
		"服务端拒绝%s时不退出，可保留表单重试",
		async (message) => {
			renderSystem();
			fireEvent.click(await screen.findByRole("button", { name: "修改账号密码" }));
			fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "fixture-current" } });
			fireEvent.change(screen.getByLabelText("新账号"), { target: { value: "owner" } });
			fireEvent.change(screen.getByLabelText("新密码"), {
				target: { value: "fixture-new-password" },
			});
			fireEvent.change(screen.getByLabelText("确认新密码"), {
				target: { value: "fixture-new-password" },
			});
			vi.mocked(api.put).mockRejectedValueOnce(new Error(message));
			fireEvent.click(screen.getByRole("button", { name: "保存并重新登录" }));
			expect(await screen.findByRole("alert")).toHaveProperty(
				"textContent",
				`修改失败：${message}`,
			);
			expect(useSessionStore.getState().authed).toBe(true);
			expect((screen.getByLabelText("新账号") as HTMLInputElement).value).toBe("owner");
			vi.mocked(api.put).mockResolvedValueOnce({ ok: true });
			fireEvent.click(screen.getByRole("button", { name: "保存并重新登录" }));
			await waitFor(() => expect(useSessionStore.getState().authed).toBe(false));
			expect(screen.queryByRole("dialog")).toBeNull();
		},
	);

	it("空字段和确认密码不一致都在本地拒绝，不提交也不退出", async () => {
		renderSystem();
		fireEvent.click(await screen.findByRole("button", { name: "修改账号密码" }));
		fireEvent.click(screen.getByRole("button", { name: "保存并重新登录" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"请填写完整的账号和密码。",
		);
		fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "fixture-current" } });
		fireEvent.change(screen.getByLabelText("新账号"), { target: { value: "owner" } });
		fireEvent.change(screen.getByLabelText("新密码"), {
			target: { value: "fixture-new-password" },
		});
		fireEvent.change(screen.getByLabelText("确认新密码"), {
			target: { value: "fixture-other-password" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存并重新登录" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"两次输入的新密码不一致。",
		);
		expect(api.put).not.toHaveBeenCalled();
		expect(useSessionStore.getState().authed).toBe(true);
	});

	it("只PUT凭据，保存中锁住表单，成功后清空弹窗并按主动退出重新登录", async () => {
		renderSystem();
		fireEvent.click(await screen.findByRole("button", { name: "修改账号密码" }));
		fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: " fixture-current " } });
		fireEvent.change(screen.getByLabelText("新账号"), { target: { value: "  owner  " } });
		fireEvent.change(screen.getByLabelText("新密码"), {
			target: { value: "fixture-new-password" },
		});
		fireEvent.change(screen.getByLabelText("确认新密码"), {
			target: { value: "fixture-new-password" },
		});
		let finish!: (value: unknown) => void;
		vi.mocked(api.put).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		fireEvent.click(screen.getByRole("button", { name: "保存并重新登录" }));
		expect(api.put).toHaveBeenCalledWith("/api/session/credentials", {
			currentPassword: " fixture-current ",
			username: "owner",
			password: "fixture-new-password",
		});
		expect(screen.getByLabelText("当前密码").matches(":disabled")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(useSessionStore.getState().authed).toBe(true);
		await act(async () => finish({ ok: true }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(useSessionStore.getState()).toMatchObject({ authed: false, expired: false });
	});

	it("登录部署可打开修改弹窗，密码字段不回显且取消后清空", async () => {
		renderSystem();
		fireEvent.click(await screen.findByRole("button", { name: "修改账号密码" }));
		const form = screen.getByRole("dialog");
		const current = within(form).getByLabelText("当前密码") as HTMLInputElement;
		expect(current.type).toBe("password");
		expect(current.autocomplete).toBe("current-password");
		fireEvent.change(current, { target: { value: "fixture-current" } });
		fireEvent.click(within(form).getByRole("button", { name: "取消" }));
		fireEvent.click(screen.getByRole("button", { name: "修改账号密码" }));
		expect((screen.getByLabelText("当前密码") as HTMLInputElement).value).toBe("");
		expect(api.put).not.toHaveBeenCalled();
	});
});
