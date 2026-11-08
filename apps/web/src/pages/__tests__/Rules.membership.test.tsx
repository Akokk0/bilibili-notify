// @vitest-environment jsdom

/**
 * 规则页 × 会员与醒目留言(㉓d)整页接线:
 *
 * - 全局的两个直播门槛(`defaults.superchat.minAmount`、`defaults.membership.minRank.guard`)改了能保存:保存条亮、
 *   PATCH 里带着这两段(漏了的话改了保存条不亮、或保存时这一段没下发);
 * - 全局上舰提示里清空某一档的文案能真的清掉:保存出去的是显式 `null`(JSON Merge Patch),不是「不提」—— 这个仓里反复栽的
 *   「关不掉 / 清不掉」,草稿合并(`deepMerge`)与 `buildPatch` 这一整条路都在这里走一遍;
 * - 只覆盖了一个门槛的订阅仍有自己的 tab(`subscriptionOverrideKeys` 漏了新两段的话它会从 tab 栏里消失)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { chooseSelect } from "../../__tests__/select-controls";
import { i18n } from "../../i18n";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalSettings } from "../../types/globals";
import Rules from "../Rules";
import { makeAi, makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function globalsWith(
	mutate: (d: ReturnType<typeof makeDefaults>) => void = () => {},
): GlobalSettings {
	const defaults = makeDefaults();
	mutate(defaults);
	return { logging: {}, master: {}, defaults, ai: makeAi() } as unknown as GlobalSettings;
}

const SOURCES = {
	sources: [
		{
			key: "sample-source",
			status: "running",
			has: {},
			descriptor: {
				label: "Sample",
				supportedFeatures: ["membership", "superchat"],
				membershipPrograms: [
					{
						id: "guard",
						name: "Sample membership",
						tiers: [
							{ key: "captain", name: "舰长", rank: 1 },
							{ key: "commander", name: "提督", rank: 2 },
							{ key: "governor", name: "总督", rank: 3 },
						],
					},
				],
			},
		},
	],
};

function mount(g: GlobalSettings, subs: Subscription[] = []) {
	vi.mocked(api.get).mockImplementation((url: string) =>
		Promise.resolve(
			url.includes("/api/subscriptions")
				? subs
				: url === "/api/sources"
					? SOURCES
					: { core: JSON.parse(JSON.stringify(g)) },
		),
	);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return {
		...render(
			<QueryClientProvider client={qc}>
				<Rules />
			</QueryClientProvider>,
		),
		qc,
	};
}

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

async function gotoSection(label: string): Promise<void> {
	await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
	fireEvent.click(screen.getAllByText(label)[0] as HTMLElement);
}

const field = (code: string): Element | null => document.querySelector(`[data-code="${code}"]`);
const diffCodes = (): string[] => useDraftStore.getState().current?.diff.map((d) => d.code) ?? [];

/** 点保存(灵动岛触发的那条路),返回下发给 `/api/settings` 的 body。 */
async function saveAndGetBody(): Promise<{ defaults: Record<string, unknown> }> {
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("rules"));
	const onSave = useDraftStore.getState().current?.onSave as (() => Promise<void>) | undefined;
	await onSave?.();
	expect(api.patch).toHaveBeenCalledWith("/api/settings", expect.anything());
	const [, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
		string,
		{ core: { defaults: Record<string, unknown> } },
	];
	return body.core;
}

describe("全局直播门槛:改了 → 保存条亮、PATCH 带着它", () => {
	it("custom membership guidance translates without rewriting program names or an unsaved default template", async () => {
		const { qc } = mount(
			globalsWith((d) => {
				d.templates.membership = {
					custom: {
						enabled: true,
						default: { template: "Original {viewer}", imageUrl: "" },
						tiers: {},
					},
				};
			}),
		);
		await gotoSection("会员提示");
		act(() =>
			qc.setQueryData(["sources"], {
				sources: [
					{
						key: "sample-source",
						status: "running",
						has: {},
						descriptor: {
							label: "Sample",
							supportedFeatures: ["membership"],
							membershipPrograms: [{ id: "custom", name: "Original membership", tiers: "custom" }],
						},
					},
				],
			}),
		);
		const input = await waitFor(() => {
			const node = field("templates.membership.custom.default.template")?.querySelector("input");
			expect(node).toBeTruthy();
			return node as HTMLInputElement;
		});
		fireEvent.change(input, { target: { value: "Original draft {viewer}" } });
		for (const [locale, hint] of [
			[
				"en",
				"Creators define their own tiers. Only the program’s default text and image are configured here.",
			],
			[
				"ja",
				"ランクはクリエイターが定義します。ここでは制度全体の既定テキストと画像のみを設定します。",
			],
			["zh-TW", "等級由創作者自訂；此處僅設定此制度的預設文案與圖片。"],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(hint)).toBeTruthy();
			expect(screen.getAllByText("Original membership").length).toBeGreaterThan(0);
			expect(screen.getByDisplayValue("Original draft {viewer}")).toBeTruthy();
		}
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("来源与语言刷新保留脏草稿，保存其他格不清未知体系", async () => {
		const { qc } = mount(
			globalsWith((d) => {
				d.membership = { minRank: { retired: 8 } };
			}),
		);
		await gotoSection("直播阈值");
		const input = await waitFor(() => {
			const node = field("superchat.minAmount")?.querySelector("input");
			expect(node).toBeTruthy();
			return node as HTMLInputElement;
		});
		fireEvent.change(input, { target: { value: "55" } });
		act(() => qc.setQueryData(["sources"], { sources: [] }));
		const prior = i18n.state();
		try {
			act(() => i18n.set({ locale: "en", voice: "plain" }));
			expect(input.value).toBe("55");
			expect(api.patch).not.toHaveBeenCalled();
			const body = await saveAndGetBody();
			expect(body.defaults.superchat).toEqual({ minAmount: 55 });
			expect(body.defaults.membership).toEqual({ minRank: { retired: 8 } });
		} finally {
			act(() => i18n.set(prior));
		}
	});
	it("改金额门槛 → 灵动岛检出 superchat.minAmount;保存的 body 里 defaults.superchat.minAmount 是新值", async () => {
		mount(globalsWith());
		await gotoSection("直播阈值");
		const input = await waitFor(() => {
			const el = field("superchat.minAmount")?.querySelector("input");
			if (!el) throw new Error("金额输入框还没出来");
			return el as HTMLInputElement;
		});
		fireEvent.change(input, { target: { value: "50" } });
		await waitFor(() => expect(diffCodes()).toContain("superchat.minAmount"));

		const body = await saveAndGetBody();
		expect(body.defaults.superchat).toEqual({ minAmount: 50 });
		expect(body.defaults.membership).toEqual({});
	});

	it("选上舰档位「总督」→ 灵动岛检出 membership.minRank;body 里是 rank 3", async () => {
		mount(globalsWith());
		await gotoSection("直播阈值");
		const picker = await waitFor(() => {
			const el = field("membership.minRank.guard")?.querySelector('[role="combobox"]');
			if (!el) throw new Error("档位选择器还没出来");
			return el as HTMLButtonElement;
		});
		chooseSelect(picker, "总督");
		// 基线里这一段是空的,所以 minRank 这一层是整个从无到有:灵动岛按 `membership.minRank` 报(字典里有名字)。
		await waitFor(() => expect(diffCodes()).toContain("membership.minRank"));

		const body = await saveAndGetBody();
		expect(body.defaults.membership).toEqual({ minRank: { guard: 3 } });
	});

	it("门槛没动过:两格显示盘上的值(金额 30、上舰「提督」),保存条不亮(草稿与基线一致)", async () => {
		mount(
			globalsWith((d) => {
				d.superchat = { minAmount: 30 };
				d.membership = { minRank: { guard: 2 } };
			}),
		);
		await gotoSection("直播阈值");
		await waitFor(() => expect(field("superchat.minAmount")).not.toBeNull());
		const amountInput = field("superchat.minAmount")?.querySelector("input");
		expect(amountInput?.value).toBe("30");
		expect(field("membership.minRank.guard")?.querySelector('[role="combobox"]')?.textContent).toBe(
			"提督",
		);
		expect(diffCodes()).toEqual([]);
	});
});

describe("全局上舰提示:清空某一档的文案 → 显式 null(清得掉)", () => {
	const guard = {
		enabled: true,
		default: { template: "{viewer} 来了", imageUrl: "" },
		tiers: {
			captain: { template: "舰长专属", imageUrl: "k.png" },
			governor: { template: "总督专属" },
		},
	};

	const tierInputs = (key: string): HTMLInputElement[] => {
		const chip = Array.from(document.querySelectorAll("code")).find((c) => c.textContent === key);
		const card = chip?.closest("div.rounded-lg");
		return Array.from(card?.querySelectorAll("input") ?? []) as HTMLInputElement[];
	};

	it("清空舰长的文案(还留着图片)→ 保存的 body 里 captain.template 是 null、captain.imageUrl 原样", async () => {
		mount(globalsWith((d) => (d.templates.membership = { guard: structuredClone(guard) })));
		await gotoSection("会员提示");
		await waitFor(() => expect(tierInputs("captain")).toHaveLength(2));
		fireEvent.change(tierInputs("captain")[0] as HTMLInputElement, { target: { value: "" } });
		// 草稿里这一格被拿掉了:输入框空着,占位显示跟随的默认。
		await waitFor(() => expect(tierInputs("captain")[0]?.value).toBe(""));
		expect(tierInputs("captain")[0]?.placeholder).toBe("{viewer} 来了");
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const body = await saveAndGetBody();
		const templates = body.defaults.templates as { membership: { guard: { tiers: unknown } } };
		expect(templates.membership.guard.tiers).toEqual({
			captain: { template: null, imageUrl: "k.png" },
			governor: { template: "总督专属" },
		});
	});

	it("清空总督唯一的一格 → 整档 null", async () => {
		mount(globalsWith((d) => (d.templates.membership = { guard: structuredClone(guard) })));
		await gotoSection("会员提示");
		await waitFor(() => expect(tierInputs("governor")).toHaveLength(2));
		fireEvent.change(tierInputs("governor")[0] as HTMLInputElement, { target: { value: "" } });
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const body = await saveAndGetBody();
		const templates = body.defaults.templates as { membership: { guard: { tiers: unknown } } };
		expect(templates.membership.guard.tiers).toEqual({
			captain: { template: "舰长专属", imageUrl: "k.png" },
			governor: null,
		});
	});

	it("清空了又填回原样:草稿回到基线,保存条熄灭(不留「改了又没改」的假脏)", async () => {
		mount(globalsWith((d) => (d.templates.membership = { guard: structuredClone(guard) })));
		await gotoSection("会员提示");
		await waitFor(() => expect(tierInputs("governor")).toHaveLength(2));
		fireEvent.change(tierInputs("governor")[0] as HTMLInputElement, { target: { value: "" } });
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));
		fireEvent.change(tierInputs("governor")[0] as HTMLInputElement, {
			target: { value: "总督专属" },
		});
		await waitFor(() => expect(diffCodes()).toEqual([]));
	});
});

describe("全局上舰提示:没配过的档敲了又删", () => {
	it("在没配过的档里敲一个字再删掉:草稿回到基线,保存条熄灭(草稿合并把 null 当「拿掉这个键」,不是存一个 null 进去)", async () => {
		mount(
			globalsWith((d) => {
				d.templates.membership = {
					guard: { enabled: true, default: { template: "{viewer} 来了", imageUrl: "" }, tiers: {} },
				};
			}),
		);
		await gotoSection("会员提示");
		const input = await waitFor(() => {
			const chip = Array.from(document.querySelectorAll("code")).find(
				(c) => c.textContent === "commander",
			);
			const el = chip?.closest("div.rounded-lg")?.querySelector("input");
			if (!el) throw new Error("提督那一块还没出来");
			return el as HTMLInputElement;
		});
		fireEvent.change(input, { target: { value: "提督来了" } });
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));
		fireEvent.change(input, { target: { value: "" } });
		await waitFor(() => expect(diffCodes()).toEqual([]));
	});
});

describe("只覆盖了一个门槛的订阅仍有自己的 tab", () => {
	it.each([
		["醒目留言金额", { superchat: { minAmount: 10 } }],
		["上舰档位", { membership: { minRank: { guard: 2 } } }],
	] as const)("只覆盖了%s → 能找到「移除个性化配置」的 tab", async (_name, overrides) => {
		const sub: Subscription = {
			...makeEmptySubscription({ sourceKey: "sample-source", externalId: "123456" }),
			overrides,
		};
		mount(globalsWith(), [sub]);
		expect(await screen.findByTitle(/移除 .* 的个性化配置/)).toBeTruthy();
	});
});
