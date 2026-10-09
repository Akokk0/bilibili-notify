// @vitest-environment jsdom

/**
 * 订阅详情「基础 → 标签」一行(ADR-0034):显示已挂的标签名(订阅上只记 id,名字按标签表查),点「编辑标签」
 * 开的是和卡片菜单**同一个**挑标签的弹框,挑完改的是草稿的 `tagIds`,点保存才随整份 POST 落盘。
 * 原来那个「英文逗号分隔」的自由文本框(打错字、中文逗号整串变一个分组的老毛病)不再存在。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	makeEmptySubscription,
	type Subscription,
	type SubscriptionTag,
} from "../../../types/domain";
import { UpDialog } from "../UpDialog";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), put: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const CHAT = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };

function subWith(tagIds: string[]): Subscription {
	return { ...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }), tagIds };
}

function renderDialog(
	sub: Subscription,
	opts: { tags?: ReadonlyArray<SubscriptionTag> } = { tags: [GAME, CHAT] },
) {
	const onClose = vi.fn();
	const onSave = vi.fn<(next: Subscription) => void>();
	// 弹框里的新建要写标签表缓存,得有个 QueryClient;不点开弹框时用不到。
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	render(
		<QueryClientProvider client={qc}>
			<UpDialog
				sub={sub}
				targets={[]}
				connections={[]}
				tags={opts.tags}
				onClose={onClose}
				onSave={onSave}
				onDelete={vi.fn()}
				saving={false}
			/>
		</QueryClientProvider>,
	);
	return { onClose, onSave };
}

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("UpDialog · 标签一行", () => {
	it("显示已挂的标签名(按订阅上 id 的顺序);没挂写「无标签」;不再有「分组」文本框", () => {
		renderDialog(subWith([CHAT.id, GAME.id]));

		// 「标签」是行的标题;行 = 标题所在的列(`parentElement`)再往上一层。
		const row = screen.getByText("标签").parentElement?.parentElement as HTMLElement;
		expect(
			within(row)
				.getAllByText(/^(杂谈|游戏)$/)
				.map((n) => n.textContent),
		).toEqual(["杂谈", "游戏"]);
		expect(screen.queryByRole("textbox", { name: "分组" })).toBeNull();
		expect(screen.queryByText("分组")).toBeNull();
	});

	it("没挂标签 → 「无标签」", () => {
		renderDialog(subWith([]));

		expect(screen.getByText("无标签")).toBeTruthy();
	});

	it("点「编辑标签」挑一个、确定 → 一行里显示出来;保存的 body 带着新的 tagIds(挑的先后保序)", () => {
		const { onSave } = renderDialog(subWith([CHAT.id]));

		fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));
		const picker = screen.getAllByRole("dialog").at(-1) as HTMLElement;
		fireEvent.click(within(picker).getByRole("checkbox", { name: "游戏" }));
		fireEvent.click(within(picker).getByText("确定"));
		fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0].tagIds).toEqual([CHAT.id, GAME.id]);
	});

	it("挑标签弹框里取消 → 草稿不变,保存仍是原来的 tagIds(没改动时保存钮直接关窗,不发保存)", () => {
		const { onSave, onClose } = renderDialog(subWith([CHAT.id]));

		fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));
		const picker = screen.getAllByRole("dialog").at(-1) as HTMLElement;
		fireEvent.click(within(picker).getByRole("checkbox", { name: "游戏" }));
		fireEvent.click(within(picker).getByText("取消"));
		fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	/**
	 * ModalShell 的 ESC 挂在 window 上,叠着的两层同时收到。详情弹窗没改动时 ESC 本来是直接关窗 ——
	 * 挑标签弹框开着的时候,这一下只该关掉上面那一层。
	 */
	it("挑标签弹框开着时按 Esc → 只关挑标签那一层,详情弹窗还在", () => {
		const { onClose } = renderDialog(subWith([CHAT.id]));
		fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));
		expect(screen.getAllByRole("dialog")).toHaveLength(2);

		fireEvent.keyDown(window, { key: "Escape" });

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
	});

	it("不给标签表(还没读到)→ 挑标签弹框不许新建", () => {
		renderDialog(subWith([]), { tags: undefined });

		fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));
		const picker = screen.getAllByRole("dialog").at(-1) as HTMLElement;
		fireEvent.change(within(picker).getByPlaceholderText("新建标签名"), {
			target: { value: "重点" },
		});

		expect((within(picker).getByText("添加").closest("button") as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});
