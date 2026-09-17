// @vitest-environment jsdom
/**
 * 卡片工坊回复末尾的预览块(ADR-0015 决策 20 / 22 的 🔗)。
 *
 * 钉的是:这条回复碰过几套就放几块;块里默认停在这一轮写过的第一种卡、切得动;读的是盘上
 * 当前那份;「换上这套」真去改全局在用的那套,已经在用的只说「正在用」;皮肤被删了说一句,
 * 不去请求一张画不出来的预览。
 */

import type { AiChatMessageDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
}));

vi.mock("../../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/card-skins") return { skins: H.skins, active: H.active, fallbacks: [] };
			const id = path.match(/^\/api\/card-skins\/([^/]+)$/)?.[1];
			if (id) return { manifest: { name: id, cards: {} }, assets: [] };
			throw new Error(`没安排的 GET ${path}`);
		}),
		post: vi.fn(async (path: string, body: { kind: string }) => {
			const id = path.match(/^\/api\/card-skins\/([^/]+)\/preview$/)?.[1];
			if (!id) throw new Error(`没安排的 POST ${path}`);
			H.previews.push({ id, kind: body.kind });
			return {
				html: `<p>${id}:${body.kind}</p>`,
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

import { CardSkinPreviews } from "../card-skin-preview";
import { MessageList } from "../messages";

function wrap(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const skin = (id: string, name: string) => ({ id, name, builtin: false, updatedAt: 1 });
const frames = () => [...document.querySelectorAll("iframe")];

beforeEach(() => {
	H.active = "default";
	H.skins = [skin("s1", "樱花粉"), skin("s2", "夜航灯")];
	H.previews = [];
	H.puts = [];
	H.warnings = [];
});
afterEach(cleanup);

describe("预览块", () => {
	it("每套一块,标题写着名字与「当前样子」,默认停在这一轮写过的第一种卡", async () => {
		wrap(
			<CardSkinPreviews
				touches={[
					{ id: "s1", kinds: ["sc", "live"] },
					{ id: "s2", kinds: [] },
				]}
			/>,
		);
		const blocks = await screen.findAllByTestId("card-skin-preview");
		expect(blocks).toHaveLength(2);
		expect(await within(blocks[0] as HTMLElement).findByText(/樱花粉/)).toBeTruthy();
		expect(within(blocks[0] as HTMLElement).getByText(/当前样子/)).toBeTruthy();
		await waitFor(() => expect(frames()).toHaveLength(2));
		expect(H.previews).toContainEqual({ id: "s1", kind: "sc" });
		// 只改了名字的那套:没有写过的卡种,落在第一种。
		expect(H.previews).toContainEqual({ id: "s2", kind: "live" });
		// 画出来的就在沙箱里:只给同源(量卡高用),不给脚本。
		expect(frames()[0]?.getAttribute("sandbox")).toBe("allow-same-origin");
	});

	it("切卡种 → 画那一种", async () => {
		wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["sc"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		fireEvent.click(within(block).getByRole("tab", { name: "直播卡" }));
		await waitFor(() => expect(H.previews).toContainEqual({ id: "s1", kind: "live" }));
	});

	it("「换上这套」→ 改全局在用的那套,换完显示「正在用」", async () => {
		wrap(<CardSkinPreviews touches={[{ id: "s1", kinds: ["live"] }]} />);
		const block = await screen.findByTestId("card-skin-preview");
		fireEvent.click(await within(block).findByRole("button", { name: "换上这套" }));
		await waitFor(() =>
			expect(H.puts).toEqual([{ path: "/api/card-skins/active", body: { id: "s1" } }]),
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
	const reply = (over: Partial<AiChatMessageDTO>): AiChatMessageDTO => ({
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
