import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
// @vitest-environment jsdom
/**
 * per-UP 编辑器头部「是谁」那一行,读订阅的身份(来源 + 来源那头的 id):
 * B 站写「UID xxx」;拓展订阅写「平台名 · 外部 id」,平台名没传就写来源键(拓展 id)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import type { SubscriptionPlatform } from "../../up/subscription-source";
import { subscriptionPlatformOf } from "../../up/subscription-source";
import { PerUpEditor } from "../PerUpEditor";
import { makeAi, makeDefaults, makeSource } from "./fixtures";

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

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetStore();
});

function renderEditor(sub: Subscription, platform?: SubscriptionPlatform) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<PerUpEditor
				sub={sub}
				platform={platform}
				defaults={makeDefaults()}
				factory={templateDefaultsFor("zh-CN")}
				presets={makeAi().presets}
				section="filter"
			/>
		</QueryClientProvider>,
	);
}

const PROFILE = { name: "某位", followers: 1, refreshedAt: "t" };

describe("PerUpEditor 头部的「是谁」", () => {
	it("B 站订阅:UID xxx", () => {
		renderEditor(
			{
				...makeEmptySubscription({ sourceKey: "bilibili", externalId: "123456" }),
				cachedProfile: PROFILE,
			},
			subscriptionPlatformOf({ sourceKey: "bilibili" }, [makeSource()]),
		);
		expect(screen.getByText(/^UID 123456 · 关闭一个分组/)).toBeTruthy();
	});

	it("拓展订阅:平台名 · 外部 id;没传平台就写拓展 id", () => {
		const sub: Subscription = {
			...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-2" }),
			cachedProfile: PROFILE,
		};
		const platform: SubscriptionPlatform = {
			label: "抖音",
			features: ["post"],
			absent: false,
			supportedExtras: [],
			status: "running",
			showBadge: true,
		};
		const { unmount } = renderEditor(sub, platform);
		expect(screen.getByText(/^抖音 · sec-2 · 关闭一个分组/)).toBeTruthy();
		unmount();
		renderEditor(sub);
		expect(screen.getByText(/^douyin · sec-2 · 关闭一个分组/)).toBeTruthy();
	});
});
