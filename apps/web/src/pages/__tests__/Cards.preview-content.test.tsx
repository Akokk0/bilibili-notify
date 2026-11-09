// @vitest-environment jsdom

/**
 * 卡片页发给服务端的 SC / 上舰预览内容(㉓e):金额叫 `amount`、上舰那一档叫 `tierKey`(档的 key,不再是 B 站的 1–3 等级)。
 * 外层的卡种键 `sc` / `guard` 不动(归 ㉔)。
 */

import type { SourcesResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { chooseSelect, selectOptionsOf } from "../../__tests__/select-controls";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription } from "../../types/domain";
import type { GlobalSettings } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

const tierPicker = () =>
	document.querySelector('[data-code="tierKey"] [role="combobox"]') as HTMLButtonElement;

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
	OFFLINE_STATUS: 0,
}));

import { i18n } from "../../i18n";
import { api } from "../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const GLOBALS = { logging: {}, master: {}, defaults: makeDefaults() } as unknown as GlobalSettings;
const SOURCES: SourcesResponse = {
	sources: [
		{
			key: "library",
			status: "running",
			descriptor: {
				label: "Library",
				supportedFeatures: ["membership"],
				membershipPrograms: [
					{
						id: "readers",
						name: "Readers",
						tiers: [
							{ key: "gold", name: "Gold", rank: 9 },
							{ key: "silver", name: "Silver", rank: 4 },
						],
					},
				],
			},
		},
	],
};

interface PreviewBody {
	kind: string;
	content?: Record<string, unknown>;
}

function previewBodies(kind: string): PreviewBody[] {
	return vi
		.mocked(api.post)
		.mock.calls.filter(([url]) => url === "/api/cards/preview")
		.map(([, body]) => body as PreviewBody)
		.filter((b) => b.kind === kind);
}

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<Cards />
			</QueryClientProvider>
		</MemoryRouter>,
	);
	return { ...view, qc };
}

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subscriptions")) return Promise.resolve([]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url === "/api/sources") return Promise.resolve(SOURCES);
		return Promise.resolve({ core: GLOBALS });
	});
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("预览请求体里的 SC 金额与上舰档", () => {
	it.each([
		[
			"zh-CN",
			"plain",
			"卡片排版与观感由皮肤控制。到「全局」分区选用皮肤；复制和编辑皮肤请前往资源库。",
		],
		[
			"zh-CN",
			"maid",
			"主人，卡片排版与观感由皮肤控制喔。到「全局」分区挑一套；想复制或编辑皮肤，请前往资源库吧。",
		],
		[
			"en",
			"plain",
			"The selected skin controls this card’s layout and appearance. Select a skin in the Global section. Duplicate or edit skins in the Library.",
		],
		[
			"ja",
			"plain",
			"カードのレイアウトと外観はスキンで決まります。「全体設定」でスキンを選択し、複製や編集はライブラリーで行ってください。",
		],
		[
			"zh-TW",
			"plain",
			"卡片版面與觀感由外觀控制。請到「全域」分區選用；複製或編輯外觀請前往資源庫。",
		],
	] as const)("%s %s 卡片皮肤指引指向现有全局分区和资源库", async (locale, voice, hint) => {
		renderCards();
		fireEvent.click((await screen.findAllByRole("button", { name: "SC 提醒" }))[0]);
		await screen.findByRole("spinbutton", { name: "展示时长（秒）" });
		act(() => i18n.set({ locale, voice }));
		expect(screen.getByText(hint)).toBeTruthy();
		expect(
			vi.mocked(api.post).mock.calls.filter(([url]) => url === "/api/cards/test"),
		).toHaveLength(0);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it.each([
		[
			"en",
			"Display duration (seconds)",
			"Sample amount (CNY)",
			"Leave blank to use a sample message",
			"Membership program",
			"New member name",
			"Leave blank to use the signed-in account name",
			"Membership alert",
		],
		[
			"ja",
			"表示時間（秒）",
			"サンプル金額（CNY）",
			"空欄ならサンプルメッセージを使用",
			"メンバーシップ制度",
			"新しいメンバーの名前",
			"空欄ならログイン中のアカウント名を使用",
			"メンバーシップ通知",
		],
		[
			"zh-TW",
			"顯示時間（秒）",
			"範例金額（CNY）",
			"留空時使用範例留言",
			"會員制度",
			"新會員稱呼",
			"留空時使用已登入的帳號名稱",
			"會員提醒",
		],
	] as const)(
		"%s preview controls translate without replacing edited message, amounts or source tier names",
		async (locale, durationLabel, amountLabel, messagePlaceholder, programLabel, memberLabel, memberPlaceholder, memberTab) => {
			renderCards();
			fireEvent.click((await screen.findAllByRole("button", { name: "SC 提醒" }))[0]);
			const duration = await screen.findByRole("spinbutton", { name: "展示时长（秒）" });
			fireEvent.change(duration, { target: { value: "17" } });
			fireEvent.click(screen.getByRole("button", { name: "6" }));
			const message = screen.getByPlaceholderText("留空就用示例留言");
			fireEvent.change(message, { target: { value: "Original message 原文" } });
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByRole("spinbutton", { name: durationLabel })).toBe(duration);
			expect(screen.getByText(amountLabel)).toBeTruthy();
			expect(screen.getByPlaceholderText(messagePlaceholder)).toBe(message);
			await waitFor(
				() =>
					expect(previewBodies("superchat").at(-1)?.content).toMatchObject({
						amount: 30,
						rank: 6,
						durationSec: 17,
						text: "Original message 原文",
					}),
				{ timeout: 5000 },
			);
			fireEvent.click(screen.getAllByRole("button", { name: memberTab })[0]);
			expect(await screen.findByText(programLabel)).toBeTruthy();
			expect(screen.getByText(memberLabel)).toBeTruthy();
			const member = screen.getByPlaceholderText(memberPlaceholder);
			fireEvent.change(member, { target: { value: "Original member 原文" } });
			chooseSelect(tierPicker(), "Gold");
			await waitFor(
				() =>
					expect(previewBodies("membership").at(-1)?.content).toMatchObject({
						program: "readers",
						tierKey: "gold",
						text: "Original member 原文",
					}),
				{ timeout: 5000 },
			);
			expect(api.patch).not.toHaveBeenCalled();
		},
	);
	it("全家福:sc 带 amount、guard 带 program 与 tierKey(默认最低一档舰长),都不再带 price / level", async () => {
		renderCards();
		await waitFor(
			() => {
				expect(previewBodies("superchat").length).toBeGreaterThan(0);
				expect(previewBodies("membership").length).toBeGreaterThan(0);
			},
			{ timeout: 5000 },
		);
		const sc = previewBodies("superchat")[0].content ?? {};
		const guard = previewBodies("membership")[0].content ?? {};
		expect(sc).toMatchObject({ amount: 30, rank: 1, durationSec: 60 });
		expect("price" in sc).toBe(false);
		expect(guard.program).toBe("readers");
		expect(guard.tierKey).toBe("silver");
		expect("level" in guard).toBe(false);
	});

	it("醒目留言：独立选择配色档位和时长，改金额不改两者", async () => {
		renderCards();
		await waitFor(() => expect(previewBodies("superchat").length).toBeGreaterThan(0));
		fireEvent.click(screen.getAllByText("SC 提醒")[0]);
		const duration = await screen.findByRole("spinbutton", { name: "展示时长（秒）" });
		expect(screen.queryByText("决定背景色与时长 (30/50/100/500/1000)")).toBeNull();
		expect(screen.getByText("示例金额（CNY）")).toBeTruthy();
		fireEvent.change(duration, { target: { value: "17" } });
		fireEvent.click(screen.getByRole("button", { name: "6" }));
		const amount = document.querySelector('[data-code="amount"] input') as HTMLInputElement;
		fireEvent.change(amount, { target: { value: "1" } });
		await waitFor(
			() =>
				expect(previewBodies("superchat").at(-1)?.content).toMatchObject({
					amount: 1,
					rank: 6,
					durationSec: 17,
				}),
			{ timeout: 5000 },
		);
		fireEvent.change(duration, { target: { value: "0" } });
		await waitFor(
			() =>
				expect(previewBodies("superchat").at(-1)?.content).toMatchObject({
					amount: 1,
					rank: 6,
					durationSec: 0,
				}),
			{ timeout: 5000 },
		);
	});

	// 验红:给 Cards.tsx 的档位选项加回 `.reverse()`,这条红。
	it("单卡上舰:档位钮由低到高摆(舰长 → 提督 → 总督),与规则页同序", async () => {
		renderCards();
		await waitFor(() => expect(screen.getAllByText("会员提醒").length).toBeGreaterThan(0), {
			timeout: 5000,
		});
		fireEvent.click(screen.getAllByText("会员提醒")[0]);
		await waitFor(() => expect(tierPicker()).not.toBeNull());
		expect(selectOptionsOf(tierPicker()).map((option) => option.textContent)).toEqual([
			"Silver",
			"Gold",
		]);
	});

	it("单卡上舰:点「总督」后请求带 tierKey governor", async () => {
		renderCards();
		await waitFor(() => expect(screen.getAllByText("会员提醒").length).toBeGreaterThan(0), {
			timeout: 5000,
		});
		fireEvent.click(screen.getAllByText("会员提醒")[0]);
		await waitFor(() => expect(tierPicker()).not.toBeNull());
		chooseSelect(tierPicker(), "Gold");
		await waitFor(
			() =>
				expect(
					previewBodies("membership").some(
						(b) => b.content?.program === "readers" && b.content?.tierKey === "gold",
					),
				).toBe(true),
			{ timeout: 5000 },
		);
	});

	it.each(["disabled", "empty", "custom"])(
		"来源%s时全家福跳过会员，单卡明确不可预览且不请求",
		async (mode) => {
			vi.mocked(api.get).mockImplementation((url: string) => {
				if (url === "/api/sources")
					return Promise.resolve({
						sources: [
							{
								...SOURCES.sources[0],
								status: mode === "disabled" ? "disabled" : "running",
								descriptor: {
									...SOURCES.sources[0].descriptor,
									membershipPrograms: [
										{
											id: "readers",
											name: "Readers",
											tiers:
												mode === "custom"
													? "custom"
													: mode === "empty"
														? []
														: (SOURCES.sources[0].descriptor.membershipPrograms?.[0]?.tiers ?? []),
										},
									],
								},
							},
						],
					});
				if (url.includes("/api/subscriptions") || url.includes("/api/targets"))
					return Promise.resolve([]);
				return Promise.resolve({ core: GLOBALS });
			});
			renderCards();
			await waitFor(() => expect(previewBodies("superchat").length).toBeGreaterThan(0));
			expect(previewBodies("membership")).toEqual([]);
			fireEvent.click(screen.getAllByText("会员提醒")[0]);
			await screen.findByText("当前来源没有可枚举的会员档位，或尚未运行，暂时无法预览。");
			expect(previewBodies("membership")).toEqual([]);
		},
	);

	it("默认选择首个在运行且可枚举的体系，跳过前面的 custom 与停用来源", async () => {
		vi.mocked(api.get).mockImplementation(async (url) => {
			if (url === "/api/sources")
				return {
					sources: [
						{
							key: "custom",
							status: "running",
							descriptor: {
								label: "Custom",
								supportedFeatures: ["membership"],
								membershipPrograms: [{ id: "custom", name: "Custom", tiers: "custom" }],
							},
						},
						{
							...SOURCES.sources[0],
							key: "stopped",
							status: "disabled",
							descriptor: {
								...SOURCES.sources[0].descriptor,
								membershipPrograms: [
									{
										id: "stopped",
										name: "Stopped",
										tiers: [{ key: "silver", name: "Stopped silver", rank: 1 }],
									},
								],
							},
						},
						...SOURCES.sources,
					],
				};
			if (url.includes("/api/subscriptions") || url.includes("/api/targets")) return [];
			return { core: GLOBALS };
		});
		renderCards();
		await waitFor(() =>
			expect(previewBodies("membership").at(-1)?.content).toMatchObject({
				program: "readers",
				tierKey: "silver",
			}),
		);
	});

	it("per-UP 仍能选择体系与档，同 key 的档不串体系", async () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "library", externalId: "0012" }),
			overrides: { cardSkin: "default" },
		};
		vi.mocked(api.get).mockImplementation(async (url) => {
			if (url === "/api/sources")
				return {
					sources: [
						{
							...SOURCES.sources[0],
							descriptor: {
								...SOURCES.sources[0].descriptor,
								membershipPrograms: [
									...(SOURCES.sources[0].descriptor.membershipPrograms ?? []),
									{
										id: "patrons",
										name: "Patrons",
										tiers: [{ key: "silver", name: "Patron silver", rank: 8 }],
									},
								],
							},
						},
					],
				};
			if (url === "/api/subscriptions") return [sub];
			if (url.includes("/api/subscriptions") || url.includes("/api/targets")) return [];
			return { core: GLOBALS };
		});
		renderCards();
		fireEvent.click(await screen.findByText("Library · 0012"));
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
		fireEvent.click(screen.getAllByText("会员提醒")[0]);
		const picker = await waitFor(() => {
			const element = document.querySelector('[data-code="program"] [role="combobox"]');
			expect(element).not.toBeNull();
			return element as HTMLButtonElement;
		});
		chooseSelect(picker, "Patrons");
		await waitFor(() => expect(tierPicker().textContent).toBe("Patron silver"));
		await waitFor(() =>
			expect(previewBodies("membership").at(-1)?.content).toMatchObject({
				subscriptionId: sub.id,
				program: "patrons",
				tierKey: "silver",
			}),
		);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("来源刷新保留仍有效的体系与档，失效只回退预览且不保存", async () => {
		const { qc } = renderCards();
		await screen.findAllByText("会员提醒");
		fireEvent.click(screen.getAllByText("会员提醒")[0]);
		await waitFor(() => expect(tierPicker()).not.toBeNull());
		chooseSelect(tierPicker(), "Gold");
		await waitFor(() => expect(previewBodies("membership").at(-1)?.content?.tierKey).toBe("gold"));
		act(() =>
			qc.setQueryData(["sources"], {
				sources: [
					{
						...SOURCES.sources[0],
						descriptor: {
							...SOURCES.sources[0].descriptor,
							membershipPrograms: [
								{
									id: "readers",
									name: "Readers refreshed",
									tiers: [
										{ key: "silver", name: "Silver refreshed", rank: 4 },
										{ key: "gold", name: "Gold refreshed", rank: 9 },
									],
								},
							],
						},
					},
				],
			}),
		);
		await waitFor(() => expect(tierPicker().textContent).toBe("Gold refreshed"));
		act(() =>
			qc.setQueryData(["sources"], {
				sources: [
					{
						...SOURCES.sources[0],
						descriptor: {
							...SOURCES.sources[0].descriptor,
							membershipPrograms: [
								{
									id: "readers",
									name: "Readers refreshed",
									tiers: [{ key: "silver", name: "Silver refreshed", rank: 4 }],
								},
							],
						},
					},
				],
			}),
		);
		await waitFor(() =>
			expect(previewBodies("membership").at(-1)?.content?.tierKey).toBe("silver"),
		);
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("单卡 SC:改金额后请求带新的 amount", async () => {
		renderCards();
		await waitFor(() => expect(screen.getAllByText("SC 提醒").length).toBeGreaterThan(0), {
			timeout: 5000,
		});
		fireEvent.click(screen.getAllByText("SC 提醒")[0]);
		const input = await waitFor(() => {
			const el = document.querySelector('[data-code="amount"] input');
			if (!el) throw new Error("金额输入框还没出来");
			return el as HTMLInputElement;
		});
		fireEvent.change(input, { target: { value: "500" } });
		await waitFor(
			() => expect(previewBodies("superchat").some((b) => b.content?.amount === 500)).toBe(true),
			{
				timeout: 5000,
			},
		);
	});
});
