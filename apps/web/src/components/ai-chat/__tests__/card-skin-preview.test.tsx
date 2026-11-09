// @vitest-environment jsdom
/**
 * 卡片工坊回复末尾的预览块(ADR-0015 决策 20 / 22 的 🔗)。
 *
 * 钉的是:这条回复碰过几套就放几块;块里默认停在这一轮写过的第一种卡、切得动;读的是盘上
 * 当前那份;「换上这套」真去改全局在用的那套,已经在用的只说「正在用」;皮肤被删了说一句,
 * 不去请求一张画不出来的预览。
 */

import type { AiChatMessageView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface Drawn {
	id: string;
	kind: string;
}

const H = vi.hoisted(() => ({
	active: "default",
	skins: [] as Record<string, unknown>[],
	previews: [] as Drawn[],
	puts: [] as unknown[],
	warnings: [] as string[],
	holdPreview: false,
	previewGates: [] as Array<() => void>,
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/cards/skins") return { skins: H.skins, active: H.active, fallbacks: [] };
			const id = path.match(/^\/api\/cards\/skins\/([^/]+)$/)?.[1];
			if (id) return { manifest: { name: id, cards: {} }, assets: [] };
			throw new Error(`没安排的 GET ${path}`);
		}),
		post: vi.fn(async (path: string, body: { kind: string }) => {
			const context = `${i18n.state().locale}:${i18n.state().voice}`;
			const id = path.match(/^\/api\/cards\/skins\/([^/]+)\/preview$/)?.[1];
			if (!id) throw new Error(`没安排的 POST ${path}`);
			H.previews.push({ id, kind: body.kind });
			if (H.holdPreview) await new Promise<void>((resolve) => H.previewGates.push(resolve));
			return {
				html: `<p>${id}:${body.kind}:${context}</p>`,
				width: 600,
				warnings: H.warnings,
				scene: "default",
			};
		}),
		put: vi.fn(async (path: string, body: { id: string }) => {
			H.puts.push({ path, body });
			H.active = body.id;
			return { ok: true };
		}),
	},
}));

import { i18n } from "../../../i18n";
import { CardSkinPreviews } from "../card-skin-preview";
import { MessageList } from "../messages";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const skin = (id: string, name: string) => ({
	id,
	name,
	builtin: false,
	updatedAt: "2026-10-27T00:00:00.000Z",
});
const frames = () => [...document.querySelectorAll("iframe")];

beforeEach(() => {
	H.active = "default";
	H.skins = [skin("s1", "樱花粉"), skin("s2", "夜航灯")];
	H.previews = [];
	H.puts = [];
	H.warnings = [];
	H.holdPreview = false;
	H.previewGates = [];
});
afterEach(() => {
	for (const release of H.previewGates.splice(0)) release();
	cleanup();
});

it("localized workshop previews retain the card kind and frame while requesting the current language", async () => {
	i18n.set({ locale: "en", voice: "plain" });
	H.warnings = ["原始提醒"];
	wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["superchat"] }]} />);
	const block = await screen.findByTestId("card-skin-preview");
	await within(block).findByText("Current appearance · Sample data");
	await waitFor(() => expect(frames()[0]?.getAttribute("srcdoc")).toContain("superchat:en:plain"));
	H.holdPreview = true;
	for (const [locale, note, apply, voice] of [
		["ja", "現在の外観 · サンプルデータ", "このスキンを使う", "plain"],
		["zh-TW", "目前外觀 · 範例資料", "套用此外觀", "plain"],
		["zh-CN", "当前样子 · 示例数据", "换上这套", "plain"],
		["zh-CN", "当前样子 · 示例数据", "换上这套", "maid"],
	] as const) {
		const previousFrame = frames()[0];
		act(() => i18n.set({ locale, voice }));
		await within(block).findByText(note);
		await waitFor(() => expect(H.previewGates).toHaveLength(1));
		expect(frames()[0]).toBe(previousFrame);
		await act(async () => H.previewGates.shift()?.());
		await waitFor(() =>
			expect(frames()[0]?.getAttribute("srcdoc")).toContain(`superchat:${locale}:${voice}`),
		);
		expect(within(block).getByText("「樱花粉」")).toBeTruthy();
		expect(within(block).getByText("原始提醒")).toBeTruthy();
		expect(within(block).getByRole("button", { name: apply })).toBeTruthy();
		expect(H.puts).toEqual([]);
	}
	expect(H.previews.every((preview) => preview.id === "s1" && preview.kind === "superchat")).toBe(
		true,
	);
	H.holdPreview = false;
	fireEvent.click(within(block).getByRole("button", { name: "换上这套" }));
	await waitFor(() =>
		expect(H.puts).toEqual([{ path: "/api/cards/skins/active", body: { id: "s1" } }]),
	);
});

describe("预览块", () => {
	it("每套一块,标题写着名字与「当前样子」,默认停在这一轮写过的第一种卡", async () => {
		wrap(
			<CardSkinPreviews
				touches={[
					{ id: "s1", kinds: ["superchat", "live"] },
					{ id: "s2", kinds: [] },
				]}
			/>,
		);
		const blocks = await screen.findAllByTestId("card-skin-preview");
		expect(blocks).toHaveLength(2);
		expect(await within(blocks[0] as HTMLElement).findByText(/樱花粉/)).toBeTruthy();
		expect(within(blocks[0] as HTMLElement).getByText(/当前样子/)).toBeTruthy();
		await waitFor(() => expect(frames()).toHaveLength(2));
		expect(H.previews).toContainEqual({ id: "s1", kind: "superchat" });
		// 只改了名字的那套:没有写过的卡种,落在第一种。
		expect(H.previews).toContainEqual({ id: "s2", kind: "live" });
		// 画出来的就在沙箱里:只给同源(量卡高用),不给脚本。
		expect(frames()[0]?.getAttribute("sandbox")).toBe("allow-same-origin");
	});

	it("切卡种 → 画那一种", async () => {
		wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["superchat"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		fireEvent.click(within(block).getByRole("tab", { name: "直播卡" }));
		await waitFor(() => expect(H.previews).toContainEqual({ id: "s1", kind: "live" }));
	});

	it("「换上这套」→ 改全局在用的那套,换完显示「正在用」", async () => {
		wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["live"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		fireEvent.click(await within(block).findByRole("button", { name: "换上这套" }));
		await waitFor(() =>
			expect(H.puts).toEqual([{ path: "/api/cards/skins/active", body: { id: "s1" } }]),
		);
		expect(await within(block).findByText("正在用")).toBeTruthy();
		expect(within(block).queryByRole("button", { name: "换上这套" })).toBeNull();
	});

	it("已经在用 → 只说「正在用」,没有钮", async () => {
		H.active = "s1";
		wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["live"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		expect(await within(block).findByText("正在用")).toBeTruthy();
		expect(within(block).queryByRole("button", { name: "换上这套" })).toBeNull();
	});

	/**
	 * 这些提示不全是「削掉了」:清洗器削掉的与装包时的提醒(用了没声明的旋钮之类)混在
	 * 一起回来,后者什么都没删。标题说成「削掉了」会让主人以为少了东西(2026-09-17 真机)。
	 */
	it("提示逐条列出,标题不说成「削掉了」", async () => {
		H.warnings = [
			"css 里用了 var(--bn-knob-font),但 knobs 里没声明它 —— 面板上没有这个控件",
			"cards.live.blocks[0].css: 丢掉了 behavior",
		];
		wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["live"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		expect(await within(block).findByText("有几处要留意:")).toBeTruthy();
		for (const w of H.warnings) expect(within(block).getByText(w)).toBeTruthy();
		expect(block.textContent).not.toMatch(/削掉/);
	});

	it("皮肤已经被删了 → 说一句,不去请求预览", async () => {
		wrap(<CardSkinPreviews touches={[{ id: "gone", kinds: ["live"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		expect(await within(block).findByText(/不在库里/)).toBeTruthy();
		expect(H.previews).toEqual([]);
		expect(within(block).queryByRole("button", { name: "换上这套" })).toBeNull();
	});
});

describe("消息流里的位置", () => {
	const AT = "2026-09-17T00:00:00.000Z";
	const reply = (over: Partial<AiChatMessageView>): AiChatMessageView => ({
		id: "a1",
		role: "assistant",
		content: "做好啦",
		ts: AT,
		...over,
	});

	it("碰过皮肤的回复末尾有预览块,没碰过的没有", async () => {
		wrap(
			<MessageList
				messages={[
					reply({ id: "a1", cardSkins: [{ id: "s1", kinds: ["live"] }] }),
					reply({ id: "a2", content: "聊两句" }),
				]}
				busy={false}
				aiSelf="女仆"
			/>,
		);
		const blocks = await screen.findAllByTestId("card-skin-preview");
		expect(blocks).toHaveLength(1);
		const turns = screen.getAllByTestId("assistant-turn");
		expect(within(turns[0] as HTMLElement).queryByTestId("card-skin-preview")).not.toBeNull();
		expect(within(turns[1] as HTMLElement).queryByTestId("card-skin-preview")).toBeNull();
	});
});

it("updates chat preview tabs after locale changes without applying a skin", async () => {
	wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["superchat"] }]} />);
	const block = await screen.findByTestId("card-skin-preview");
	const live = within(block).getByRole("tab", { name: "直播卡" });
	const selected = within(block).getByRole("tab", { selected: true });
	const previous = i18n.state();
	try {
		for (const [locale, name] of [
			["en", "Live card"],
			["ja", "配信カード"],
			["zh-TW", "直播卡片"],
		] as const) {
			await act(async () => {
				i18n.set({ locale, voice: "plain" });
			});
			expect(within(block).getByRole("tab", { name })).toBe(live);
			expect(within(block).getByRole("tab", { selected: true })).toBe(selected);
		}
		expect(H.puts).toEqual([]);
	} finally {
		await act(async () => {
			i18n.set(previous);
		});
	}
});

it.each([
	["ja", "ご主人様、このスキンはもうライブラリーにないので、プレビューできませんよ。"],
	["zh-TW", "主人，這套卡片皮膚已經不在資源庫裡，沒辦法預覽了喔。"],
] as const)("%s 女仆缺失提示不绘制或启用已删除的卡片皮肤", async (locale, hint) => {
	wrap(<CardSkinPreviews touches={[{ id: "gone", kinds: ["live"] }]} />);
	const block = await screen.findByTestId("card-skin-preview");
	await within(block).findByText(/不在库里/);
	act(() => i18n.set({ locale, voice: "maid" }));
	expect(within(block).getByText(hint)).toBeTruthy();
	expect(H.previews).toEqual([]);
	expect(H.puts).toEqual([]);
	expect(within(block).queryByRole("button")).toBeNull();
});
