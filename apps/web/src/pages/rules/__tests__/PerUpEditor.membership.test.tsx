import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
// @vitest-environment jsdom
/**
 * per-UP 编辑器里会员与醒目留言的两处(㉓d):
 *
 * - 「直播阈值覆盖」:醒目留言金额落在 `overrides.superchat.minAmount`、上舰档位落在 `overrides.membership.minRank.guard`
 *   (rank),不再往 `overrides.filters` 里写;关掉 = 整段(或 B 站那一项)显式 null,服务端才真的删;
 * - 「上舰提示覆盖」:订阅自己的一整份 B 站体系文案(`overrides.templates.membership.guard`:enabled + 体系默认 + 按档覆盖),
 *   开 = 以全局那份为起点整份换成订阅的;关 = 这一项拿掉。
 *
 * 清空一个覆盖要真的能清掉(这个仓里反复栽的「关不掉」):保存走 `buildOverridesPatch`,这里直接看下发给服务端的 PATCH body。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../../services/api";
import { useDraftStore } from "../../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import type { GlobalDefaults } from "../../../types/globals";
import { PerUpEditor } from "../PerUpEditor";
import type { SectionId } from "../sections";
import { makeAi, makeDefaults } from "./fixtures";

vi.mock("../../../services/api", () => ({
	api: { patch: vi.fn() },
	ApiError: class extends Error {},
}));

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

const subOf = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({ sourceKey: "sample-source", externalId: "123456" }),
	overrides,
});

function renderEditor(sub: Subscription, section: SectionId, defaults: GlobalDefaults) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<PerUpEditor
				sub={sub}
				defaults={defaults}
				factory={templateDefaultsFor("zh-CN")}
				presets={makeAi().presets}
				section={section}
			/>
		</QueryClientProvider>,
	);
	const field = (code: string) => view.container.querySelector(`[data-code="${code}"]`);
	const headerToggle = () => view.container.querySelector("button") as HTMLButtonElement;
	return { field, headerToggle, ...view };
}

const diff = () => useDraftStore.getState().current?.diff ?? [];
const diffCodes = () => diff().map((d) => d.code);

/** 点保存(灵动岛触发的那条路),返回下发给服务端的 `overrides`。 */
async function saveAndGetOverrides(sub: Subscription): Promise<Record<string, unknown>> {
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("rules-perup"));
	const onSave = useDraftStore.getState().current?.onSave as (() => Promise<void>) | undefined;
	await onSave?.();
	expect(api.patch).toHaveBeenCalledWith(`/api/subscriptions/${sub.id}`, expect.anything());
	const body = vi.mocked(api.patch).mock.calls.at(-1)?.[1] as {
		overrides: Record<string, unknown>;
	};
	return body.overrides;
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

/** 全局:金额门槛 30、上舰门槛 rank 2(提督以上),上舰文案一份有内容的。 */
function globalsWithThresholds(): GlobalDefaults {
	const defaults = makeDefaults();
	defaults.superchat = { minAmount: 30 };
	defaults.membership = { minRank: { guard: 2 } };
	return defaults;
}

describe("「直播阈值覆盖」× 醒目留言与会员的门槛", () => {
	it("打开覆盖 → 两段门槛钉成当前全局值(整段从无到有,diff 按段报)", async () => {
		const { headerToggle } = renderEditor(subOf(), "live", globalsWithThresholds());
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes()).toContain("superchat"));
		expect(diff().find((d) => d.code === "superchat")?.newValue).toEqual({ minAmount: 30 });
		expect(diff().find((d) => d.code === "membership")?.newValue).toEqual({
			minRank: { guard: 2 },
		});
		// 不碰过滤域。
		expect(diffCodes()).not.toContain("filters");
		expect(diffCodes()).not.toContain("blockKeywords");
	});

	it("全局没配门槛:打开覆盖钉成「金额 0、上舰 rank 1(全推)」", async () => {
		const { headerToggle } = renderEditor(subOf(), "live", makeDefaults());
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes()).toContain("superchat"));
		expect(diff().find((d) => d.code === "superchat")?.newValue).toEqual({ minAmount: 0 });
		expect(diff().find((d) => d.code === "membership")?.newValue).toEqual({
			minRank: { guard: 1 },
		});
	});

	it("覆盖里的值盖过全局:金额输入显示覆盖的 0(不是全局的 30),档位选中覆盖的那一档", () => {
		const sub = subOf({ superchat: { minAmount: 0 }, membership: { minRank: { guard: 3 } } });
		const { field, container } = renderEditor(sub, "live", globalsWithThresholds());
		expect(within(container).getByText("覆盖中")).toBeTruthy();
		const input = field("superchat.minAmount")?.querySelector("input") as HTMLInputElement;
		expect(input.value).toBe("0");
		const pressed = Array.from(field("membership.minRank.guard")?.querySelectorAll("button") ?? [])
			.filter((b) => b.getAttribute("aria-pressed") === "true")
			.map((b) => b.textContent);
		expect(pressed).toEqual(["总督"]);
	});

	it("只覆盖了金额门槛(没碰档位)→ 这一节算「覆盖中」,档位那格显示全局的值", () => {
		const sub = subOf({ superchat: { minAmount: 10 } });
		const { field, container } = renderEditor(sub, "live", globalsWithThresholds());
		expect(within(container).getByText("覆盖中")).toBeTruthy();
		const pressed = Array.from(field("membership.minRank.guard")?.querySelectorAll("button") ?? [])
			.filter((b) => b.getAttribute("aria-pressed") === "true")
			.map((b) => b.textContent);
		expect(pressed).toEqual(["提督"]);
	});

	it("改金额与档位 → 保存的 PATCH 里 overrides.superchat / overrides.membership 是新值,不碰 filters", async () => {
		const sub = subOf({ superchat: { minAmount: 10 }, membership: { minRank: { guard: 2 } } });
		const { field } = renderEditor(sub, "live", globalsWithThresholds());
		fireEvent.change(field("superchat.minAmount")?.querySelector("input") as HTMLInputElement, {
			target: { value: "100" },
		});
		const buttons = Array.from(
			field("membership.minRank.guard")?.querySelectorAll("button") ?? [],
		) as HTMLButtonElement[];
		fireEvent.click(buttons[0] as HTMLButtonElement); // 舰长 = rank 1(全推)
		await waitFor(() => expect(diffCodes()).toContain("superchat.minAmount"));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.superchat).toEqual({ minAmount: 100 });
		expect(overrides.membership).toEqual({ minRank: { guard: 1 } });
		expect(overrides).not.toHaveProperty("filters");
	});

	it("关掉覆盖并保存 → superchat 与 membership 各自显式 null(不会保存后又复活)", async () => {
		const sub = subOf({ superchat: { minAmount: 0 }, membership: { minRank: { guard: 1 } } });
		const { headerToggle } = renderEditor(sub, "live", globalsWithThresholds());
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes()).toContain("superchat"));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.superchat).toBeNull();
		expect(overrides.membership).toBeNull();
	});

	it("关掉覆盖时会员门槛里还有别的体系的:只清 B 站那一项(minRank.guard 置 null),别的体系原样", async () => {
		const sub = subOf({
			superchat: { minAmount: 5 },
			membership: { minRank: { guard: 2, other: 3 } },
		});
		const { headerToggle } = renderEditor(sub, "live", globalsWithThresholds());
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes()).toContain("superchat"));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.superchat).toBeNull();
		expect(overrides.membership).toEqual({ minRank: { guard: null, other: 3 } });
	});
});

describe("「上舰提示覆盖」× 体系文案", () => {
	const guardGlobal = {
		enabled: false,
		default: { template: "全局默认 {viewer}", imageUrl: "" },
		tiers: { captain: { template: "全局舰长", imageUrl: "g-cap.png" } },
	};
	const withGlobalGuard = (): GlobalDefaults => {
		const defaults = makeDefaults();
		defaults.templates.membership = { guard: structuredClone(guardGlobal) };
		return defaults;
	};
	const ownGuard = (over: object = {}) => ({
		enabled: true,
		default: { template: "订阅默认 {viewer}", imageUrl: "" },
		tiers: {},
		...over,
	});
	const subWithGuard = (guard: object, rest: object = {}): Subscription =>
		subOf({ templates: { ...rest, membership: { guard } } } as Subscription["overrides"]);

	it("没有覆盖:「继承」,不画输入框", () => {
		const { container } = renderEditor(subOf(), "guard", withGlobalGuard());
		expect(within(container).getByText("继承")).toBeTruthy();
		expect(container.querySelectorAll("input")).toHaveLength(0);
	});

	it("打开覆盖 → 以全局那份为起点整份换成订阅的(带上全局的体系默认与每档文案),enabled: true;全局那份不被改动", async () => {
		const defaults = withGlobalGuard();
		const { headerToggle } = renderEditor(subOf(), "guard", defaults);
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes()).toContain("templates"));
		expect(diff().find((d) => d.code === "templates")?.newValue).toEqual({
			membership: { guard: { ...guardGlobal, enabled: true } },
		});
		expect(defaults.templates.membership.guard).toEqual(guardGlobal);
	});

	it("覆盖开着:输入框显示订阅这份的值;没填的格占位显示这份体系默认", () => {
		const sub = subWithGuard(
			ownGuard({ tiers: { commander: { template: "提督专属", imageUrl: "c.png" } } }),
		);
		const { container } = renderEditor(sub, "guard", withGlobalGuard());
		expect(within(container).getByText("覆盖中")).toBeTruthy();
		const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
		// 体系默认(文案、图片),舰长(文案、图片),提督(文案、图片),总督(文案、图片)
		expect(inputs.map((i) => i.value)).toEqual([
			"订阅默认 {viewer}",
			"",
			"",
			"",
			"提督专属",
			"c.png",
			"",
			"",
		]);
		expect(inputs[2]?.placeholder).toBe("订阅默认 {viewer}");
	});

	it("改某一档的文案并保存 → PATCH 里 templates.membership.guard 是订阅这份的新样子", async () => {
		const sub = subWithGuard(ownGuard());
		const { container } = renderEditor(sub, "guard", withGlobalGuard());
		const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
		fireEvent.change(inputs[4] as HTMLInputElement, { target: { value: "提督来了" } }); // 提督的文案
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.templates).toEqual({
			membership: { guard: ownGuard({ tiers: { commander: { template: "提督来了" } } }) },
		});
	});

	it("清空这一档的一格 → 那一格显式 null;清空这一档最后一格 → 整档显式 null(清得掉)", async () => {
		const sub = subWithGuard(
			ownGuard({
				tiers: {
					captain: { template: "舰长专属", imageUrl: "k.png" },
					governor: { template: "总督专属" },
				},
			}),
		);
		const { container } = renderEditor(sub, "guard", withGlobalGuard());
		const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
		fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: "" } }); // 舰长的文案
		fireEvent.change(inputs[6] as HTMLInputElement, { target: { value: "" } }); // 总督的文案(唯一的一格)
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.templates).toEqual({
			membership: {
				guard: {
					enabled: true,
					default: { template: "订阅默认 {viewer}", imageUrl: "" },
					tiers: { captain: { template: null, imageUrl: "k.png" }, governor: null },
				},
			},
		});
	});

	it("改体系默认并保存 → PATCH 里 guard.default 是新的", async () => {
		const sub = subWithGuard(ownGuard());
		const { container } = renderEditor(sub, "guard", withGlobalGuard());
		const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
		fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "新的订阅默认" } });
		fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "d.png" } });
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.templates).toEqual({
			membership: { guard: ownGuard({ default: { template: "新的订阅默认", imageUrl: "d.png" } }) },
		});
	});

	it("关掉覆盖 → 只覆盖了这一件时 templates 整段显式 null", async () => {
		const sub = subWithGuard(ownGuard());
		const { headerToggle } = renderEditor(sub, "guard", withGlobalGuard());
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.templates).toBeNull();
	});

	it("关掉覆盖 → 同一份 templates 里别的覆盖(开播文案)原样、别的体系的文案原样;只有 B 站这一项显式 null", async () => {
		const other = ownGuard({ default: { template: "别的体系", imageUrl: "" } });
		const sub = subOf({
			templates: { liveStart: "我的开播", membership: { guard: ownGuard(), other } },
		} as Subscription["overrides"]);
		const { headerToggle } = renderEditor(sub, "guard", withGlobalGuard());
		fireEvent.click(headerToggle());
		await waitFor(() => expect(diffCodes().length).toBeGreaterThan(0));

		const overrides = await saveAndGetOverrides(sub);
		expect(overrides.templates).toEqual({
			liveStart: "我的开播",
			membership: { guard: null, other },
		});
	});
});
