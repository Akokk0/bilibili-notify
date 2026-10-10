// @vitest-environment jsdom
/**
 * per-UP 编辑器里直播拆键(⑬d)的那几格:周期间隔落在 `overrides.liveStreaming`、启动补报落在
 * `overrides.liveStart`,不再往 `overrides.schedule` 里写。
 *
 * - B 站「直播阈值覆盖」:打开 = 把阈值、免扰 / 断流接续、周期间隔、补报都钉成当前全局值(一份快照),关掉 = 全部清掉;
 *   只覆盖了周期间隔或补报的订阅,这一节也算「覆盖中」;
 * - 间隔输入的上下限是 1 与 24;
 * - 拓展订阅「推送时段」:声明了开播与下播的源才有这两格(同弹层那一行「直播中」的规则),只报作品的源只有免扰时段。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../../services/api";
import { useDraftStore } from "../../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import type { SubscriptionPlatform } from "../../up/subscription-source";
import { PerUpEditor } from "../PerUpEditor";
import type { SectionId } from "../sections";
import { makeDefaults } from "./fixtures";

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

const biliSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
	overrides,
});

const extSub = (overrides: Subscription["overrides"] = {}): Subscription => ({
	...makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" }),
	overrides,
});

const platformOf = (features: SubscriptionPlatform["features"]): SubscriptionPlatform => ({
	label: "抖音",
	features,
	absent: false,
});

function renderEditor(sub: Subscription, section: SectionId, platform?: SubscriptionPlatform) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<PerUpEditor
				sub={sub}
				platform={platform}
				defaults={makeDefaults()}
				presets={makeDefaults().ai.presets}
				section={section}
			/>
		</QueryClientProvider>,
	);
	const field = (code: string) => view.container.querySelector(`[data-code="${code}"]`);
	return { field, ...view };
}

const diffCodes = (): string[] => useDraftStore.getState().current?.diff.map((d) => d.code) ?? [];

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

describe("B 站「直播阈值覆盖」× 周期间隔与启动补报", () => {
	it("打开覆盖 → 阈值、免扰 / 断流接续、周期间隔、补报各段一并钉成全局值(整段从无到有,diff 按段报)", async () => {
		const { container } = renderEditor(biliSub(), "live");
		fireEvent.click(container.querySelector("button") as Element);
		await waitFor(() => expect(diffCodes()).toContain("liveStreaming"));
		for (const slice of ["liveStart", "schedule", "superchat", "membership"]) {
			expect(diffCodes(), slice).toContain(slice);
		}
		// 钉下的值就是全局那份(fixtures 里的出厂值)。
		const diff = useDraftStore.getState().current?.diff ?? [];
		expect(diff.find((d) => d.code === "liveStreaming")?.newValue).toEqual({
			streamingIntervalHours: 1,
		});
		expect(diff.find((d) => d.code === "liveStart")?.newValue).toEqual({ catchUpOnBoot: false });
		// 两个门槛(㉓d)钉成全局值:没配 → 金额 0、上舰 rank 1(全推)。
		expect(diff.find((d) => d.code === "superchat")?.newValue).toEqual({ minAmount: 0 });
		expect(diff.find((d) => d.code === "membership")?.newValue).toEqual({
			minRank: { guard: 1 },
		});
	});

	it("覆盖里只写了周期间隔(没碰阈值与 schedule)→ 这一节算「覆盖中」,输入显示这条的值,上下限 1–24", () => {
		const { container, field } = renderEditor(
			biliSub({ liveStreaming: { streamingIntervalHours: 3 } }),
			"live",
		);
		expect(within(container).getByText("覆盖中")).toBeTruthy();
		const input = field("liveStreaming.streamingIntervalHours")?.querySelector(
			"input",
		) as HTMLInputElement;
		expect(input.value).toBe("3");
		expect(input.getAttribute("min")).toBe("1");
		expect(input.getAttribute("max")).toBe("24");
	});

	it("覆盖里只写了启动补报 → 同样算「覆盖中」", () => {
		const { container } = renderEditor(biliSub({ liveStart: { catchUpOnBoot: true } }), "live");
		expect(within(container).getByText("覆盖中")).toBeTruthy();
	});

	it("改间隔 → diff 里是 liveStreaming.streamingIntervalHours;保存 → 补丁落在 overrides.liveStreaming", async () => {
		const sub = biliSub({ liveStreaming: { streamingIntervalHours: 3 } });
		const { field } = renderEditor(sub, "live");
		const input = field("liveStreaming.streamingIntervalHours")?.querySelector(
			"input",
		) as HTMLInputElement;
		fireEvent.change(input, { target: { value: "6" } });
		await waitFor(() => expect(diffCodes()).toContain("liveStreaming.streamingIntervalHours"));
		expect(
			useDraftStore
				.getState()
				.current?.diff.find((d) => d.code === "liveStreaming.streamingIntervalHours"),
		).toMatchObject({ oldValue: 3, newValue: 6 });

		await useDraftStore.getState().current?.onSave();
		expect(api.patch).toHaveBeenCalledWith(
			`/api/subscriptions/${sub.id}`,
			expect.objectContaining({
				overrides: expect.objectContaining({ liveStreaming: { streamingIntervalHours: 6 } }),
			}),
		);
	});

	it("关掉覆盖 → 周期间隔与补报两段都清掉(发 null),不只清 schedule", async () => {
		const sub = biliSub({
			liveStreaming: { streamingIntervalHours: 3 },
			liveStart: { catchUpOnBoot: true },
		});
		const { container } = renderEditor(sub, "live");
		fireEvent.click(container.querySelector("button") as Element);
		await waitFor(() => expect(diffCodes()).toContain("liveStreaming"));

		await useDraftStore.getState().current?.onSave();
		expect(api.patch).toHaveBeenCalledWith(
			`/api/subscriptions/${sub.id}`,
			expect.objectContaining({
				overrides: expect.objectContaining({ liveStreaming: null, liveStart: null }),
			}),
		);
	});
});

describe("拓展订阅「推送时段覆盖」× 周期间隔与启动补报", () => {
	// 覆盖开着(盘上有 schedule)格子才展开。
	const enabledExt = (): Subscription => extSub({ schedule: { quietHours: [] } });

	it("声明了开播与下播的源:有周期间隔与补报两格;间隔上下限 1–24", () => {
		const { field } = renderEditor(
			enabledExt(),
			"schedule",
			platformOf(["post", "liveStart", "liveStreaming", "liveEnd"]),
		);
		const input = field("liveStreaming.streamingIntervalHours")?.querySelector("input");
		expect(input?.getAttribute("min")).toBe("1");
		expect(input?.getAttribute("max")).toBe("24");
		expect(field("liveStart.catchUpOnBoot")).not.toBeNull();
	});

	it("只报作品的源:只有免扰时段,没有这两格", () => {
		const { field } = renderEditor(enabledExt(), "schedule", platformOf(["post"]));
		expect(field("schedule.quietHours")).not.toBeNull();
		expect(field("liveStreaming.streamingIntervalHours")).toBeNull();
		expect(field("liveStart.catchUpOnBoot")).toBeNull();
	});

	it("只报开播、没有下播的源:有补报、没有周期;开覆盖只钉画出来的那几段", async () => {
		const { container } = renderEditor(extSub(), "schedule", platformOf(["post", "liveStart"]));
		fireEvent.click(container.querySelector("button") as Element);
		await waitFor(() => expect(diffCodes()).toContain("liveStart"));
		expect(diffCodes()).toContain("schedule");
		expect(diffCodes()).not.toContain("liveStreaming");
	});

	it("只有周期间隔覆盖的拓展订阅,这一节也算开着(推送时段覆盖不止看 schedule)", () => {
		const { field } = renderEditor(
			extSub({ liveStreaming: { streamingIntervalHours: 5 } }),
			"schedule",
			platformOf(["post", "liveStart", "liveStreaming", "liveEnd"]),
		);
		const input = field("liveStreaming.streamingIntervalHours")?.querySelector(
			"input",
		) as HTMLInputElement;
		expect(input.value).toBe("5");
	});
});
