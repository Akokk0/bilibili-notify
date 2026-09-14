// @vitest-environment jsdom

/**
 * 卡片皮肤库那一节(ADR-0014 决策 5 / 20)。
 *
 * 钉的五条各对应一个静默失败:① 内置那份排首位 + 「使用中」跟着 `active` 走(排序
 * 写反 / 徽标读错字段,页面照样长得像一回事);② 「启用」打的是 `PUT /active`(启用
 * 指针住在配置里,不在店里);③ 删不掉时服务端那句「谁在用」原样露给主人 ——
 * 自编一句「删除失败」等于把唯一能照着去改的线索吞掉;④ 内置那份**没有**删除钮
 * (摆一颗点了必失败的钮是骗人);⑤ 上传成功后列表真的重取(不 invalidate 的话新
 * 装的皮肤要刷页面才看得见)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CardSkinSection } from "../CardSkinSection";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			readonly status: number,
			readonly body: unknown,
			message: string,
		) {
			super(message);
		}
	}
	return { FakeApiError };
});

vi.mock("../../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(),
		put: vi.fn(),
		post: vi.fn(),
		delete: vi.fn(),
		upload: vi.fn(),
	},
}));

import { api } from "../../../services/api";

/** 服务端刻意把内置那份排在后面 —— 首位是本节自己排出来的,不是抄来的顺序。 */
const LIST = {
	skins: [
		{
			id: "aurora",
			name: "极光",
			author: "伦伦酱",
			description: "冷色玻璃",
			builtin: false,
			updatedAt: 2,
		},
		{ id: "default", name: "默认皮肤", builtin: true, updatedAt: 0 },
	],
	active: "aurora",
};

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<CardSkinSection />
		</QueryClientProvider>,
	);
}

/** 某套皮肤那一行(行内按钮都从这里面找,免得撞上别行的同名钮)。 */
async function rowOf(name: string): Promise<HTMLElement> {
	const label = await screen.findByText(name);
	const row = label.closest("div.flex.items-center.gap-3");
	if (!row) throw new Error(`row for ${name} not found`);
	return row as HTMLElement;
}

beforeEach(() => {
	vi.mocked(api.get).mockResolvedValue(LIST);
	vi.mocked(api.put).mockResolvedValue({ ok: true });
	vi.mocked(api.post).mockResolvedValue({ id: "aurora-copy" });
	vi.mocked(api.delete).mockResolvedValue({ ok: true });
	vi.mocked(api.upload).mockResolvedValue({ id: "new-skin", warnings: [] });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/**
 * 出图回落的账本(决策 19「回落必须可见」)。刻意不做 toast —— 回落发生在推送那一刻,
 * 主人多半不在面板前。这两条钉的是:**列得出来**(账本下发了却没人画,等于决策 19 没做),
 * 以及**「知道了」真的打到服务端**(只在前端藏起来的话,刷一下页面它又回来了)。
 */
describe("卡片皮肤库 · 回落告警", () => {
	const WITH_FALLBACK = {
		...LIST,
		fallbacks: [
			{ skinId: "aurora", kind: "live", reason: "渲染失败(超时)", at: 1_757_000_000_000, count: 3 },
		],
	};

	it("账本非空 → 把「哪套皮肤、哪种卡、为什么」摆出来,皮肤名按 id 对回去", async () => {
		vi.mocked(api.get).mockResolvedValue(WITH_FALLBACK);
		renderSection();
		const note = await screen.findByText(/有卡片没能按皮肤画出来/);
		// WarnNote 自带 `data-bn="note note-warn"` —— 爬到它那层才是整块告警,
		// 爬一层只会停在标题那个 div 上。
		const box = note.closest('[data-bn~="note"]');
		if (!box) throw new Error("告警盒没渲染");
		expect(within(box as HTMLElement).getByText(/极光 的直播卡渲染失败\(超时\)/)).toBeTruthy();
		// 账本记的是 id,面板要回头对成名字 —— 对不上才退回 id。
		expect(box.textContent).not.toContain("aurora");
		expect(box.textContent).toContain("3 次");
	});

	it("点「知道了」打 DELETE /api/card-skins/fallbacks 并重取列表", async () => {
		vi.mocked(api.get).mockResolvedValue(WITH_FALLBACK);
		renderSection();
		const before = vi.mocked(api.get).mock.calls.length;
		fireEvent.click(await screen.findByText("知道了"));
		await waitFor(() =>
			expect(vi.mocked(api.delete)).toHaveBeenCalledWith("/api/card-skins/fallbacks"),
		);
		await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(before));
	});

	it("账本空 → 一个字都不画", async () => {
		renderSection();
		await screen.findByText("极光");
		expect(screen.queryByText(/有卡片没能按皮肤画出来/)).toBeNull();
	});
});

describe("卡片皮肤库", () => {
	it("内置那份排首位,「使用中」跟着 active 走", async () => {
		renderSection();
		await screen.findByText("默认皮肤");

		const names = screen.getAllByText(/默认皮肤|极光/).map((el) => el.textContent);
		expect(names[0]).toBe("默认皮肤");

		expect(within(await rowOf("默认皮肤")).getByText("内置")).toBeTruthy();
		// active = aurora,所以「使用中」在极光那行,不在内置那行。
		expect(within(await rowOf("极光")).getByText("使用中")).toBeTruthy();
		expect(within(await rowOf("默认皮肤")).queryByText("使用中")).toBeNull();
		// 作者与描述合成一行。
		expect(screen.getByText("by 伦伦酱 · 冷色玻璃")).toBeTruthy();
	});

	it("「启用」打 PUT /api/card-skins/active", async () => {
		renderSection();
		const row = await rowOf("默认皮肤");
		fireEvent.click(within(row).getByRole("button", { name: "启用" }));

		await waitFor(() =>
			expect(api.put).toHaveBeenCalledWith("/api/card-skins/active", { id: "default" }),
		);
	});

	it("正在用的那套没有「启用」钮(显示「已启用」且禁用)", async () => {
		renderSection();
		const row = await rowOf("极光");
		const btn = within(row).getByRole("button", { name: "已启用" }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	it("内置那份不给删除钮", async () => {
		renderSection();
		expect(within(await rowOf("默认皮肤")).queryByRole("button", { name: "删除" })).toBeNull();
		// 反面:自制那套有。
		expect(within(await rowOf("极光")).getByRole("button", { name: "删除" })).toBeTruthy();
	});

	it("删除撞 409 → 把服务端说的「谁在用」原样显示出来", async () => {
		vi.mocked(api.delete).mockRejectedValue(
			new FakeApiError(
				409,
				{ ok: false, usedBy: { global: true, subscriptions: ["小白"] } },
				"这套皮肤还在用（全局默认，小白 单独指定了它），换掉之后再删",
			),
		);

		renderSection();
		const row = await rowOf("极光");
		fireEvent.click(within(row).getByRole("button", { name: "删除" }));

		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

		await screen.findByText(/这套皮肤还在用（全局默认，小白 单独指定了它），换掉之后再删/);
	});

	it("上传成功 → 列表重取,并把清洗提示列出来", async () => {
		vi.mocked(api.upload).mockResolvedValue({
			id: "new-skin",
			warnings: ["直播卡「封面」块的 filter 声明已丢弃"],
		});

		const { container } = renderSection();
		await screen.findByText("极光");
		const before = vi.mocked(api.get).mock.calls.length;

		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File([new Uint8Array([1, 2, 3])], "skin.zip", { type: "application/zip" });
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() => expect(api.upload).toHaveBeenCalled());
		const [uploadUrl, form] = vi.mocked(api.upload).mock.calls[0] as [string, FormData];
		expect(uploadUrl).toBe("/api/card-skins");
		expect(form.get("file")).toBe(file);

		// invalidate 之后列表必须真的再取一次 —— 不然新装的皮肤要刷页面才看得见。
		await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(before));
		await screen.findByText("直播卡「封面」块的 filter 声明已丢弃");
	});
});
