// @vitest-environment jsdom

/**
 * 系统页账号卡 —— 聚合列表按来源显示登录六态，操作经 `useSourceAuth`。
 *
 * 钉住的约定：
 * ① 六种取值各自的标签、正文与按钮可点性；
 * ② `confirming` 一个取值两种情况：扫码弹窗开着时（本地见过 `awaiting-scan`）话在弹窗里，没开着
 *    （开机没确认、刷新过页面）话在卡片上。**面板分这两种靠本地布尔值，不靠比对 `message` 的文字**——
 *    所以两种情况下用同一句话，弹窗在不在是唯一的区别；
 * ③ 「刷新 Cookie」与「最近 Cookie 刷新」没了；
 * ④ 账号头像从图库取（`/api/images/<引用>`），没有则保留通用账号占位。
 */

import type { SourceAuthResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { applySourceAuthChanged } from "../../hooks/use-source-auth";
import { i18n } from "../../i18n";
import System from "../System";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

vi.mock("../../hooks/useDirtyDraft", () => ({ useDirtyDraft: () => {} }));

const { FakeApiError, H } = vi.hoisted(() => ({
	FakeApiError: class extends Error {},
	H: {
		auth: { state: { status: "logged-out" } } as Record<string, unknown>,
		posted: [] as string[],
		deleted: [] as string[],
		postResult: { state: { status: "logged-out" } } as Record<string, unknown>,
	},
}));

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/accounts")
				return { accounts: [{ sourceKey: "library", ...(await H.auth) }] };
			if (url === "/api/sources")
				return {
					sources: [
						{
							key: "library",
							status: "running",
							has: { auth: true },
							descriptor: { label: "书库", shortLabel: "书", color: "#888", icon: "globe" },
						},
					],
				};
			if (url === "/api/settings") {
				return {
					core: {
						logging: { level: "info", levels: {}, retentionDays: 7, memoryLog: { enabled: false } },
						history: { retentionDays: 30 },
						stats: { enabled: true },
						master: { targetId: undefined },
					},
					bilibili: { dynamicCron: "0 * * * *", healthCheckMinutes: 30 },
				};
			}
			if (url === "/api/connections/capabilities") return {};
			return [];
		}),
		post: vi.fn(async (url: string) => {
			H.posted.push(url);
			H.auth = H.postResult;
			return H.postResult;
		}),
		delete: vi.fn(async (url: string) => {
			H.deleted.push(url);
			H.auth = { state: { status: "logged-out" } };
			return H.auth;
		}),
		patch: vi.fn(async () => ({})),
	},
}));

const NOW = "2026-10-11T00:00:00.000Z";
const QR = "data:image/png;base64,AAAA";

let qc: QueryClient;

function renderSystem() {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter initialEntries={["/system"]}>
			<QueryClientProvider client={qc}>
				<System />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/** WS 帧到了的效果：状态当场写进缓存。 */
function pushState(state: SourceAuthResponse["state"]): void {
	act(() => {
		H.auth = { ...H.auth, state };
		applySourceAuthChanged(qc, { sourceKey: "library", state });
	});
}

const modal = () => document.querySelector('[data-bn="modal"]');
const startButton = () => screen.getByRole("button", { name: /扫码登录书库|继续扫码书库|处理中/ });

beforeEach(() => {
	H.auth = { state: { status: "logged-out" } };
	H.posted = [];
	H.deleted = [];
	H.postResult = { state: { status: "logged-out" } };
});

afterEach(() => {
	cleanup();
});

describe("系统页账号卡 · 六种登录状态", () => {
	it.each([
		[
			"ja",
			"ご主人様、书库のアカウントにはまだログインしていません。QRログインから始められますよ。",
			"书库にはログインしていません。QRコードをスキャンしてログインしてください。",
		],
		[
			"zh-TW",
			"主人，還沒登入书库帳號，點擊掃碼登入就能開始囉。",
			"尚未登入书库帳號，點擊掃碼登入即可開始。",
		],
	] as const)("%s：账号提示随口吻切换，来源原名保留且不自动登录", async (locale, maid, plain) => {
		renderSystem();
		await screen.findByText("尚未登录书库账号，点击扫码登录开始。");
		for (const [voice, expected] of [
			["maid", maid],
			["plain", plain],
		] as const) {
			await act(async () => i18n.set({ locale, voice }));
			expect(screen.getByText(expected)).toBeTruthy();
			expect(H.posted).toEqual([]);
			expect(H.deleted).toEqual([]);
		}
	});

	it.each([
		["en", "Raw sign-in snapshot"],
		["ja", "ログイン状態の元データ"],
		["zh-TW", "原始登入快照"],
	] as const)(
		"%s translates snapshot heading while retaining the exact source response",
		async (locale, title) => {
			H.auth = {
				state: { status: "error", message: "Original auth diagnostic 原文" },
				account: { name: "Original account 原文" },
			};
			renderSystem();
			await screen.findByText("Original auth diagnostic 原文");
			const disclosure = screen.getByText("原始登录快照").closest("details");
			const raw = disclosure?.querySelector("pre")?.textContent;
			expect(JSON.parse(raw ?? "")).toEqual({ accounts: [{ sourceKey: "library", ...H.auth }] });
			await act(async () => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(title).closest("details")).toBe(disclosure);
			expect(disclosure?.querySelector("pre")?.textContent).toBe(raw);
			expect(H.posted).toEqual([]);
			expect(H.deleted).toEqual([]);
		},
	);

	it("状态还没取到：等待账号列表，不能对未知来源发起操作", async () => {
		H.auth = new Promise(() => {}) as never;
		renderSystem();
		expect(await screen.findByText("正在读取账号…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /扫码登录|退出.*登录/ })).toBeNull();
		expect(modal()).toBeNull();
	});

	it("logged-out：未登录标签与提示，发起可点", async () => {
		renderSystem();
		expect(await screen.findByText("尚未登录书库账号，点击扫码登录开始。")).toBeTruthy();
		expect(screen.getByText("未登录")).toBeTruthy();
		expect((startButton() as HTMLButtonElement).disabled).toBe(false);
		expect(modal()).toBeNull();
	});

	it("awaiting-scan：弹窗显示二维码与扫码提示，按钮变「继续扫码」", async () => {
		H.auth = {
			state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } },
		};
		renderSystem();
		const img = (await screen.findByAltText("书库登录二维码")) as HTMLImageElement;
		expect(img.getAttribute("src")).toBe(QR);
		expect(screen.getByText("使用书库客户端扫码登录")).toBeTruthy();
		expect(screen.getByRole("button", { name: "继续扫码书库" })).toBeTruthy();
	});

	it("awaiting-scan 关掉弹窗后：按钮「继续扫码」重开同一张码，不重新发起", async () => {
		H.auth = {
			state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } },
		};
		renderSystem();
		await screen.findByAltText("书库登录二维码");
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(modal()).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "继续扫码书库" }));
		expect(await screen.findByAltText("书库登录二维码")).toBeTruthy();
		expect(H.posted).toEqual([]);
	});

	it("关闭扫码弹窗后切换分区再回来，仍由继续扫码重开原码", async () => {
		H.auth = {
			state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } },
		};
		renderSystem();
		await screen.findByAltText("书库登录二维码");
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(modal()).toBeNull());
		fireEvent.click(screen.getAllByRole("button", { name: "运行" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "账号" })[0]);
		expect(modal()).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "继续扫码书库" }));
		expect((await screen.findByAltText("书库登录二维码")).getAttribute("src")).toBe(QR);
		expect(H.posted).toEqual([]);
	});

	it("confirming · 弹窗开着（见过 awaiting-scan）：话在弹窗里，不画二维码，卡片正文不重复", async () => {
		H.auth = {
			state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } },
		};
		renderSystem();
		await screen.findByAltText("书库登录二维码");
		pushState({ status: "confirming", message: "已扫码，请在手机上确认" });
		await waitFor(() => expect(screen.queryByAltText("书库登录二维码")).toBeNull());
		expect(modal()?.textContent).toContain("已扫码，请在手机上确认");
		// 话只在弹窗里写一遍（卡片正文不重复）。
		expect(screen.getAllByText("已扫码，请在手机上确认")).toHaveLength(1);
	});

	it("confirming · 弹窗没开（开机没确认、没见过 awaiting-scan）：话在卡片上，没有弹窗，发起可点", async () => {
		// 与上一条同一句话——区别只有本地见没见过 awaiting-scan，面板不靠比对文字分。
		H.auth = { state: { status: "confirming", message: "已扫码，请在手机上确认" } };
		renderSystem();
		expect(await screen.findByText("已扫码，请在手机上确认")).toBeTruthy();
		expect(modal()).toBeNull();
		expect((startButton() as HTMLButtonElement).disabled).toBe(false);
		expect(startButton().textContent).toBe("扫码登录");
	});

	it("confirming 没带 message：卡片上写「正在确认」", async () => {
		H.auth = { state: { status: "confirming" } };
		renderSystem();
		// 标签与正文各一处。
		expect((await screen.findAllByText("正在确认")).length).toBe(2);
		expect(modal()).toBeNull();
	});

	it("confirming 之后回到 logged-out 再来 confirming：弹窗不会凭空复活", async () => {
		H.auth = {
			state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } },
		};
		renderSystem();
		await screen.findByAltText("书库登录二维码");
		pushState({ status: "logged-out" });
		await waitFor(() => expect(modal()).toBeNull());
		pushState({
			status: "confirming",
			message: "正在向 B 站确认登录状态，暂时连不上的话会自动重试",
		});
		expect(
			await screen.findByText("正在向 B 站确认登录状态，暂时连不上的话会自动重试"),
		).toBeTruthy();
		expect(modal()).toBeNull();
	});

	it("logged-in：账号名与图库头像，发起禁用、退出可点，没有刷新 Cookie", async () => {
		H.auth = {
			state: { status: "logged-in", loggedInAt: NOW },
			account: { name: "晨风UP主", avatar: "avatar0123456789abcdef.webp" },
		};
		renderSystem();
		expect(await screen.findByText("晨风UP主")).toBeTruthy();
		const img = document.querySelector('[data-bn="avatar"] img, img[src^="/api/images/"]');
		expect(img?.getAttribute("src")).toBe("/api/images/avatar0123456789abcdef.webp");
		expect((startButton() as HTMLButtonElement).disabled).toBe(true);
		expect(
			(screen.getByRole("button", { name: "退出书库登录" }) as HTMLButtonElement).disabled,
		).toBe(false);
		expect(screen.queryByText(/刷新 Cookie/)).toBeNull();
		expect(screen.queryByText(/最近 Cookie 刷新/)).toBeNull();
	});

	it("logged-in 但账号还没取到：名字回落「已登录账号」，头像是首字母", async () => {
		H.auth = { state: { status: "logged-in", loggedInAt: NOW } };
		renderSystem();
		expect(await screen.findByText("已登录账号")).toBeTruthy();
		expect(document.querySelector('img[src^="/api/images/"]')).toBeNull();
	});

	it("expired：红框显示服务端给的那句话，发起可点", async () => {
		H.auth = { state: { status: "expired", message: "账号登录已失效，请重新扫码登录" } };
		renderSystem();
		expect(await screen.findByText("账号登录已失效，请重新扫码登录")).toBeTruthy();
		expect(screen.getByText("登录已失效")).toBeTruthy();
		expect((startButton() as HTMLButtonElement).disabled).toBe(false);
	});

	it("error：红框显示服务端给的那句话（二维码超时就是它），发起可点", async () => {
		H.auth = { state: { status: "error", message: "二维码已超时（3分钟），请重新登录" } };
		renderSystem();
		expect(await screen.findByText("二维码已超时（3分钟），请重新登录")).toBeTruthy();
		expect(screen.getByText("登录失败")).toBeTruthy();
		expect((startButton() as HTMLButtonElement).disabled).toBe(false);
	});

	it("点「发起扫码登录」：POST 来源登录口，回包写进缓存，弹窗随即打开", async () => {
		H.postResult = {
			state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } },
		};
		renderSystem();
		await screen.findByText("尚未登录书库账号，点击扫码登录开始。");
		fireEvent.click(startButton());
		expect(await screen.findByAltText("书库登录二维码")).toBeTruthy();
		expect(H.posted).toEqual(["/api/sources/library/auth"]);
	});

	it("点「退出登录」：DELETE 来源登录口", async () => {
		H.auth = {
			state: { status: "logged-in", loggedInAt: NOW },
			account: { name: "晨风UP主" },
		};
		renderSystem();
		await screen.findByText("晨风UP主");
		fireEvent.click(screen.getByRole("button", { name: "退出书库登录" }));
		await waitFor(() => expect(H.deleted).toEqual(["/api/sources/library/auth"]));
		expect(await screen.findByText("尚未登录书库账号，点击扫码登录开始。")).toBeTruthy();
	});
});

it("账号列表读取失败时显示未知，重试恢复也不会重新弹出已收起的码", async () => {
	H.auth = { state: { status: "awaiting-scan", qr: { dataUrl: QR, expiresAt: NOW } } };
	renderSystem();
	await screen.findByAltText("书库登录二维码");
	fireEvent.keyDown(document, { key: "Escape" });
	const { api } = await import("../../services/api");
	vi.mocked(api.get).mockRejectedValueOnce(new Error("temporary offline"));
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["accounts"] });
	});
	expect(await screen.findByText("账号列表未能读取，当前状态未知。")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "继续扫码书库" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "重试" }));
	await screen.findByRole("button", { name: "继续扫码书库" });
	expect(modal()).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "继续扫码书库" }));
	expect(await screen.findByAltText("书库登录二维码")).toBeTruthy();
});
