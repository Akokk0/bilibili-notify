// @vitest-environment jsdom

/**
 * **per-UP 那侧的旋钮面板**(ADR-0014 决策 17 的 🔗,2026-09-24)。
 *
 * 卡片页 per-UP 作用域,皮肤下拉下面摆「这位 UP 实际用的那套」的旋钮面板(复用全局那块,换个
 * 模式):没单独拧过的标「跟随全局」、起始位置是全局那份的值;拧一枚进 `overrides.cardSkinKnobs`;
 * 「还原」把这一枚删掉、回到跟随全局。只看**发出去的东西**(PATCH 与预览请求)与屏上那一行 ——
 * 零件的测试证明不了线接上了。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const SKIN_LIST = {
	skins: [
		{
			id: "default",
			name: "默认",
			builtin: true,
			updatedAt: 0,
			knobs: [
				{
					key: "glass-opacity",
					label: "玻璃白纱",
					type: "number",
					default: 0.82,
					min: 0,
					max: 1,
					step: 0.01,
				},
				{ key: "gradient-start", label: "背景渐变起色", type: "color", default: "#fb7299" },
			],
		},
		{
			id: "aurora",
			name: "极光",
			builtin: false,
			updatedAt: 1,
			knobs: [{ key: "neon", label: "霓虹色", type: "color", default: "#00f0ff" }],
		},
	],
	active: "default",
	fallbacks: [],
};

/** 全局那份拧过玻璃白纱(0.5)—— per-UP 没拧的那一枚该从这儿起步,不是皮肤的 0.82。 */
const GLOBAL_KNOBS = { default: { "glass-opacity": 0.5 } };

function mockApi(sub: Subscription): void {
	const defaults = makeDefaults() as unknown as Record<string, unknown>;
	defaults.cardSkinKnobs = GLOBAL_KNOBS;
	const globals = { app: {}, master: {}, defaults } as unknown as GlobalConfig;
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subs")) return Promise.resolve([sub]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url.includes("/api/card-skins")) return Promise.resolve(SKIN_LIST);
		return Promise.resolve(globals);
	});
	vi.mocked(api.patch).mockResolvedValue(sub);
}

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<Cards />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

/** 切到这位 UP 的 per-UP 作用域。 */
async function openPerUp(uid: string): Promise<void> {
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
	fireEvent.click(await screen.findByText(`UID ${uid}`));
	await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards-perup"));
}

async function knobRow(key: string): Promise<HTMLElement> {
	return await waitFor(() => {
		const el = document.querySelector(`[data-knob="${key}"]`);
		if (!el) throw new Error(`旋钮 ${key} 那一行还没渲染出来`);
		return el as HTMLElement;
	});
}

/** 保存并取回最后那一份 per-UP PATCH 的 overrides。 */
async function saveAndReadOverrides(subId: string): Promise<Record<string, unknown>> {
	useDraftStore.getState().current?.onSave();
	await waitFor(() => expect(api.patch).toHaveBeenCalled());
	const [url, body] = vi.mocked(api.patch).mock.calls.at(-1) as [
		string,
		{ overrides: Record<string, unknown> },
	];
	expect(url).toBe(`/api/subs/${subId}`);
	return body.overrides;
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("per-UP 那侧的旋钮面板", () => {
	/**
	 * 这位 UP 没单独指皮肤 → 面板是全局在用那套的旋钮;没拧过的标「跟随全局」,起始位置是
	 * **全局那份**的值。验红:把 per-UP 面板的起始值换回只看 per-UP 那层(`knobValue(knob,
	 * overrides)`),滑杆会停在皮肤默认的 0.82,这条红。
	 */
	it("没单独指皮肤 → 摆全局那套的旋钮,全部标「跟随全局」,起始位置取全局那份", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardSkin: undefined, cardStyle: { font: "x" } },
		};
		mockApi(sub);
		renderCards();
		await openPerUp("123456");

		const row = await knobRow("glass-opacity");
		expect(within(row).getByText("跟随全局")).toBeTruthy();
		expect((row.querySelector('input[type="range"]') as HTMLInputElement).value).toBe("0.5");
		// 没拧过就没有「还原」可点 —— 本来就没有键可删。
		expect(within(row).queryByText("还原")).toBeNull();
		expect(within(await knobRow("gradient-start")).getByText("跟随全局")).toBeTruthy();
	});

	it("单独指了一套 → 摆的是那一套的旋钮,不是全局那套", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardSkin: "aurora" },
		};
		mockApi(sub);
		renderCards();
		await openPerUp("123456");

		await knobRow("neon");
		expect(document.querySelector('[data-knob="glass-opacity"]')).toBeNull();
	});

	/**
	 * 拧一枚:进 PATCH 的 `overrides.cardSkinKnobs`(按皮肤 id 分),预览请求当场带上草稿 ——
	 * 不必先保存。验红:把 `savePerUp` 里 `cardSkinKnobs` 那一格删掉,第一条断言红;把
	 * 预览的 `cardSkinKnobs` 那一格删掉,第二条红。
	 */
	it("拧一枚 → PATCH 带上它,预览请求也带着草稿;那一行不再标「跟随全局」", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardStyle: { font: "x" } },
		};
		mockApi(sub);
		renderCards();
		await openPerUp("123456");

		const row = await knobRow("glass-opacity");
		fireEvent.change(row.querySelector('input[type="range"]') as HTMLInputElement, {
			target: { value: "0.3" },
		});
		await waitFor(() => expect(within(row).queryByText("跟随全局")).toBeNull());
		expect(within(row).getByText("还原")).toBeTruthy();

		await waitFor(
			() => {
				const call = vi.mocked(api.post).mock.calls.find(([url, body]) => {
					const b = body as { cardSkinKnobs?: Record<string, Record<string, unknown>> };
					return (
						url === "/api/cards/preview" && b?.cardSkinKnobs?.default?.["glass-opacity"] === 0.3
					);
				});
				expect(call).toBeTruthy();
			},
			{ timeout: 2000 },
		);

		const overrides = await saveAndReadOverrides(sub.id);
		expect(overrides.cardSkinKnobs).toEqual({ default: { "glass-opacity": 0.3 } });
	});

	/**
	 * 「还原」= 这一枚退回跟随全局 = 把键**删掉**:PATCH 里那一枚是显式 null(键消失的话
	 * 服务端读作「别动」,还原永远不生效 —— 本仓「配置 PATCH 的删除语义」那一族)。同一套里
	 * 别的那枚原样留着。只有这位 UP 那份旋钮的订阅也得进得了 tab(它就是「定制过」)。
	 */
	it("还原 → PATCH 里那一枚是显式 null,别的那枚不动,那一行回到「跟随全局」", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: {
				cardSkinKnobs: { default: { "glass-opacity": 0.3, "gradient-start": "#123456" } },
			},
		};
		mockApi(sub);
		renderCards();
		await openPerUp("123456");

		const row = await knobRow("glass-opacity");
		expect((row.querySelector('input[type="range"]') as HTMLInputElement).value).toBe("0.3");
		fireEvent.click(within(row).getByText("还原"));
		await waitFor(() => expect(within(row).getByText("跟随全局")).toBeTruthy());
		// 回到跟随全局 → 起始位置是全局那份,不是皮肤默认。
		expect((row.querySelector('input[type="range"]') as HTMLInputElement).value).toBe("0.5");

		const overrides = await saveAndReadOverrides(sub.id);
		// buildPatch 照发没变的值(不做「相同就省略」),所以别的那枚原样在;还原的那一枚是 null。
		expect(overrides.cardSkinKnobs).toEqual({
			default: { "glass-opacity": null, "gradient-start": "#123456" },
		});
	});

	it("最后一枚也还原了 → 整份 cardSkinKnobs 发 null,不留一个空壳", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardSkinKnobs: { default: { "glass-opacity": 0.3 } } },
		};
		mockApi(sub);
		renderCards();
		await openPerUp("123456");

		fireEvent.click(within(await knobRow("glass-opacity")).getByText("还原"));
		const overrides = await saveAndReadOverrides(sub.id);
		expect("cardSkinKnobs" in overrides).toBe(true);
		expect(overrides.cardSkinKnobs).toBeNull();
	});

	it("全局作用域的预览不带 per-UP 草稿 —— 全局那份服务端自己从配置里读", async () => {
		mockApi({ ...makeEmptySubscription("123456"), overrides: {} });
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));
		await waitFor(
			() =>
				expect(
					vi.mocked(api.post).mock.calls.filter(([url]) => url === "/api/cards/preview").length,
				).toBeGreaterThan(0),
			{ timeout: 2000 },
		);
		const withKnobs = vi.mocked(api.post).mock.calls.find(([url, body]) => {
			const b = body as { cardSkinKnobs?: unknown };
			return url === "/api/cards/preview" && b?.cardSkinKnobs !== undefined;
		});
		expect(withKnobs).toBeFalsy();
	});
});

/**
 * **测试推送与预览同一份皮肤**:所见即所推。per-UP 作用域的预览带着这位 UP 的皮肤与草稿旋钮,测试推送
 * 也得带 —— 从前测试推送一个字都不传,推出去的是全局那套,与屏上的预览对不上。全局作用域两边都不传
 * (服务端自己从配置里读)。
 */
describe("测试推送带着与预览同一份皮肤", () => {
	const TARGET = { id: "t1", name: "群一", enabled: true };

	function mockWithTarget(sub: Subscription): void {
		mockApi(sub);
		const base = vi.mocked(api.get).getMockImplementation();
		vi.mocked(api.get).mockImplementation((url: string) =>
			url.includes("/api/targets") ? Promise.resolve([TARGET]) : (base?.(url) as Promise<unknown>),
		);
		vi.mocked(api.post).mockImplementation((url: string) =>
			Promise.resolve(
				url === "/api/cards/test-push"
					? { ok: true, latencyMs: 5 }
					: { ok: true, dataUrl: "data:image/png;base64,xx" },
			),
		);
	}

	/** 切到 SC 那个类型 tab(测试推送只在类型 tab 里),点「测试推送」,回发出去的请求体。 */
	async function testPush(): Promise<Record<string, unknown>> {
		fireEvent.click(screen.getAllByRole("button", { name: "SC 提醒" })[0] as HTMLElement);
		const btn = await screen.findByRole("button", { name: "测试推送" });
		await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(btn);
		return await waitFor(() => {
			const call = vi.mocked(api.post).mock.calls.find(([url]) => url === "/api/cards/test-push");
			if (!call) throw new Error("测试推送还没发出去");
			return call[1] as Record<string, unknown>;
		});
	}

	/** 验红:把 TestPushCard 请求体里的 `cardSkin` / `cardSkinKnobs` 删掉,这条红。 */
	it("per-UP:测试推送带着这位 UP 的皮肤与草稿旋钮(没保存的那一拧也在)", async () => {
		const sub: Subscription = {
			...makeEmptySubscription("123456"),
			overrides: { cardSkin: "aurora", cardSkinKnobs: { aurora: { neon: "#123456" } } },
		};
		mockWithTarget(sub);
		renderCards();
		await openPerUp("123456");

		const row = await knobRow("neon");
		fireEvent.change(row.querySelector('input[type="text"]') as HTMLInputElement, {
			target: { value: "#ff0000" },
		});

		const body = await testPush();
		expect(body.targetId).toBe("t1");
		expect(body.cardSkin).toBe("aurora");
		expect(body.cardSkinKnobs).toEqual({ aurora: { neon: "#ff0000" } });
	});

	it("全局作用域:测试推送与预览一样,皮肤与旋钮都不传", async () => {
		mockWithTarget({ ...makeEmptySubscription("123456"), overrides: {} });
		renderCards();
		await waitFor(() => expect(useDraftStore.getState().current?.pageKey).toBe("cards"));

		const body = await testPush();
		expect(body.targetId).toBe("t1");
		expect(body.cardSkin).toBeUndefined();
		expect(body.cardSkinKnobs).toBeUndefined();
	});
});
