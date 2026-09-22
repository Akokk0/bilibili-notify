// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://192.168.1.20:8787/extensions/bridge"}

/**
 * 拓展交来的积木怎么画(ADR-0019 决策 27):`keyValue` / `table` / `notice` / `copy` / `qr` /
 * `button`。版式照今天的桥页 —— bot 表、地址行、提示条都是照着那一页的样子搬过来的,所以
 * 这里钉的是「它们说的还是同一件事」:三态三种说法、图例在场、地址在浏览器里算、按钮失败时
 * 服务端那句原话摆在按得到它的地方。
 */

import type { ExtensionBlock } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../../../services/api";
import { Blocks } from "../blocks";
import { extensionStatusKey, useExtensionView } from "../view-query";

vi.mock("../../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

/** 一枚 1×1 的 png —— 表格 icon 格与二维码都只收图片 data URL。 */
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 挂一个跟页面一样读状态那一口的观察者 —— 看「按完之后状态重读了没」就数它问了几次。 */
function StatusProbe({ id }: { id: string }) {
	useExtensionView(id, true);
	return null;
}

function renderBlocks(
	blocks: readonly ExtensionBlock[],
	opts: { id?: string; legend?: boolean; onSet?: (set: Record<string, unknown>) => void } = {},
) {
	const id = opts.id ?? "douyin";
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<StatusProbe id={id} />
			<Blocks blocks={blocks} extensionId={id} legend={opts.legend} onSet={opts.onSet} />
		</QueryClientProvider>,
	);
	return Object.assign(view, { qc });
}

/** 读状态那一口被问了几次。 */
function statusReads(id = "douyin"): number {
	return vi.mocked(api.get).mock.calls.filter(([url]) => url === `/api/ext/${id}/status`).length;
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.post).mockReset();
	vi.mocked(api.get).mockResolvedValue({});
});
afterEach(() => {
	cleanup();
});

describe("keyValue", () => {
	it("一格一对:名字在上、值在下,值是富文本", () => {
		renderBlocks([
			{
				type: "keyValue",
				items: [
					{ label: "登录", value: "cookie 有效", tone: "ok" },
					{ label: "在看的作者", value: [{ b: "12" }, " 位"] },
				],
			},
		]);
		const login = screen.getByText("登录").closest("div");
		expect(login?.textContent).toBe("登录cookie 有效");
		const authors = screen.getByText("在看的作者").closest("div");
		expect(authors?.textContent).toBe("在看的作者12 位");
		expect(within(authors as HTMLElement).getByText("12").tagName).toBe("STRONG");
	});
});

describe("table", () => {
	const BOTS: ExtensionBlock = {
		type: "table",
		title: "它驮着的 bot",
		count: true,
		empty: "桥连上了,但它现在一个 bot 都没有。",
		columns: [
			{ kind: "icon" },
			{ kind: "text", width: 210 },
			{ kind: "tristate", label: "@全体" },
			{ kind: "tristate", label: "合并转发" },
			{ kind: "tristate", label: "markdown" },
		],
		rows: [
			[
				{ image: PNG, fallback: "qq" },
				{ text: "小粉", sub: "onebot · 2854196310" },
				"yes",
				"no",
				"unknown",
			],
			[{ fallback: "tg" }, "小电视", "unknown", "unknown", "yes"],
		],
	};

	it("标题旁带行数", () => {
		renderBlocks([BOTS]);
		const title = screen.getByText("它驮着的 bot");
		expect(title.parentElement?.textContent).toBe("它驮着的 bot2");
	});

	/** icon 格只有两级(决策 31):拓展给的图 → 两个字母。BN 不拿自己的平台表去补。 */
	it("icon 格:有图画图,没图印两个字母", () => {
		const { container } = renderBlocks([BOTS]);
		const imgs = container.querySelectorAll("img");
		expect(imgs).toHaveLength(1);
		expect(imgs[0]?.getAttribute("src")).toBe(PNG);
		expect(screen.getByText("tg")).toBeTruthy();
	});

	it("文字格两行:名字 + 等宽小字,定宽", () => {
		renderBlocks([BOTS]);
		const name = screen.getByText("小粉");
		const cell = name.parentElement as HTMLElement;
		expect(cell.textContent).toBe("小粉onebot · 2854196310");
		expect(within(cell).getByText("onebot · 2854196310").className).toContain("font-mono");
		// 定宽是版式的承重件:多行排下来,三态记号得在同一条竖线上起排。
		expect(cell.style.width).toBe("210px");
	});

	/**
	 * 🔴 三态三种说法(ADR-0009 决策 10):「不支持」是结论,「还不知道」是「试试看」。
	 * 字面说明挂在 title 上,读屏器与悬停都够得着。
	 */
	it("三态格:支持 / 不支持 / 还不知道分开说", () => {
		renderBlocks([BOTS]);
		expect(screen.getAllByTitle("@全体:支持")).toHaveLength(1);
		expect(screen.getAllByTitle("合并转发:不支持")).toHaveLength(1);
		expect(screen.getAllByTitle("markdown:还不知道")).toHaveLength(1);
		expect(screen.getAllByTitle("@全体:还不知道")).toHaveLength(1);
	});

	it("一行都没有时说那句 empty,不画空表", () => {
		renderBlocks([{ ...BOTS, rows: [] } as ExtensionBlock]);
		expect(screen.getByText("桥连上了,但它现在一个 bot 都没有。")).toBeTruthy();
		expect(screen.getByText("它驮着的 bot").parentElement?.textContent).toBe("它驮着的 bot0");
	});

	/** 页上一出现三态格就挂图例(决策 27)—— 两个空心圈不说明就只能猜。 */
	it("要图例时,有三态列的表挂一次图例", () => {
		renderBlocks([BOTS], { legend: true });
		expect(screen.getAllByRole("list", { name: "图例" })).toHaveLength(1);
	});

	it("没有三态列的表不挂图例", () => {
		renderBlocks(
			[{ type: "table", columns: [{ kind: "mono" }], rows: [["abc"]] } as ExtensionBlock],
			{ legend: true },
		);
		expect(screen.queryByRole("list", { name: "图例" })).toBeNull();
		expect(screen.getByText("abc").className).toContain("font-mono");
	});
});

describe("notice", () => {
	it("info 是虚线旁注,等宽的地址在浏览器里算", () => {
		const { container } = renderBlocks(
			[{ type: "notice", tone: "info", text: ["插件那头要填 ", { host: "extensionUrl" }] }],
			{ id: "bridge" },
		);
		const note = container.querySelector('[data-bn="note"]');
		expect(note?.textContent).toBe("插件那头要填 ws://192.168.1.20:8787/ext/bridge");
	});

	it("warn 是黄盒,带警示图标,头一句加粗", () => {
		const { container } = renderBlocks([
			{
				type: "notice",
				tone: "warn",
				text: [{ b: "cookie 还有 3 天过期。" }, "过期之后作品列表就拿不到了。"],
			},
		]);
		const note = container.querySelector('[data-bn~="note-warn"]') as HTMLElement;
		expect(note.textContent).toBe("cookie 还有 3 天过期。过期之后作品列表就拿不到了。");
		expect(note.querySelector("svg")).toBeTruthy();
		expect(within(note).getByText("cookie 还有 3 天过期。").tagName).toBe("STRONG");
	});

	it("error 是红盒", () => {
		renderBlocks([{ type: "notice", tone: "error", text: "登录被平台踢了 —— 重新扫一次。" }]);
		expect(screen.getByRole("alert").textContent).toBe("登录被平台踢了 —— 重新扫一次。");
	});

	it("可带一颗按钮,按下去调拓展的动作", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true });
		renderBlocks([
			{
				type: "notice",
				tone: "warn",
				text: "cookie 快过期了。",
				button: { label: "现在检查一次", action: "poll.now" },
			},
		]);
		fireEvent.click(screen.getByRole("button", { name: "现在检查一次" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/ext/douyin/actions/poll.now"));
	});
});

describe("copy", () => {
	/** 今天头卡上那一行:名字 + 值 + 复制 | 一句说明。 */
	it("值是 BN 现算的地址时照地址栏算,带复制钮与说明", () => {
		renderBlocks(
			[
				{
					type: "copy",
					label: "BN 地址",
					value: { host: "extensionUrl" },
					note: ["这是", { b: "桥那台机器" }, "要访问得到的地址"],
				},
			],
			{ id: "bridge" },
		);
		expect(screen.getByText("ws://192.168.1.20:8787/ext/bridge")).toBeTruthy();
		expect(screen.getByRole("button", { name: "复制 BN 地址" })).toBeTruthy();
		expect(screen.getByText("桥那台机器").tagName).toBe("STRONG");
	});

	it("值是字符串就原样摆", () => {
		renderBlocks([{ type: "copy", label: "设备码", value: "ABCD-1234" }]);
		expect(screen.getByText("ABCD-1234")).toBeTruthy();
		expect(screen.getByRole("button", { name: "复制 设备码" })).toBeTruthy();
	});

	/**
	 * 🔴 BN 常经 `http://<内网 IP>:8787` 打开,那里 `navigator.clipboard` 根本不存在 —— 裸写法
	 * 按下去静默无事。抄错地址与抄错 token 一样连不上,而头卡上这一行正是桥那台机器要抄的地址。
	 */
	it("非安全上下文里也真的复制到", async () => {
		vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
		const execCommand = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, "execCommand", {
			value: execCommand,
			configurable: true,
			writable: true,
		});
		try {
			renderBlocks([{ type: "copy", label: "BN 地址", value: { host: "extensionUrl" } }], {
				id: "bridge",
			});
			fireEvent.click(screen.getByRole("button", { name: "复制 BN 地址" }));
			await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
		} finally {
			vi.unstubAllGlobals();
			Reflect.deleteProperty(document, "execCommand");
		}
	});
});

describe("qr", () => {
	it("画拓展交来的那张图,下面一行说明", () => {
		renderBlocks([{ type: "qr", image: PNG, caption: "用抖音 App 扫码" }]);
		expect(screen.getByRole("img", { name: "二维码" }).getAttribute("src")).toBe(PNG);
		expect(screen.getByText("用抖音 App 扫码")).toBeTruthy();
	});

	/** 🔴 图只收 data URL:一个 http 地址当 `<img src>` 画,面板一开就去对家点名。 */
	it("不是图片 data URL 的不画", () => {
		const { container } = renderBlocks([
			{ type: "qr", image: "https://evil.example/track.png", caption: "扫我" },
		]);
		expect(container.querySelector("img")).toBeNull();
	});
});

describe("button", () => {
	it("调拓展:按下去 POST 那个动作,成了就重读状态", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true });
		renderBlocks([{ type: "button", label: "现在检查一次", action: "poll.now" }]);
		await waitFor(() => expect(statusReads()).toBe(1));

		fireEvent.click(screen.getByRole("button", { name: "现在检查一次" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/ext/douyin/actions/poll.now"));
		await waitFor(() => expect(statusReads()).toBe(2));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	/**
	 * 🔴 失败的原因不许吞:四种失败(没声明 / 代码没接 / 超时 / 拓展自己抛了)服务端各有一句
	 * 原话,那是主人唯一能照着做的线索。
	 */
	it.each([
		"拓展 douyin 的清单里没有动作 poll.now",
		"拓展 douyin 声明了动作 poll.now,代码却没接",
		"动作 poll.now 超过 30 秒没回",
		"cookie 已经失效,重新粘一份",
	])("失败时把服务端那句原话摆出来:%s", async (reason) => {
		vi.mocked(api.post).mockRejectedValue(new Error(reason));
		renderBlocks([{ type: "button", label: "现在检查一次", action: "poll.now" }]);
		fireEvent.click(screen.getByRole("button", { name: "现在检查一次" }));
		expect((await screen.findByRole("alert")).textContent).toContain(reason);
	});

	/**
	 * 🔴 状态那一口**照旧取消重发**:宿主不替它发失效帧,在飞的那一发可能是动作之前就发出去的
	 * (窗口聚焦、上一帧 bot 快照)—— 并过去就拿着动作之前的样子,要等下一次变化才更新。
	 */
	it("调拓展:状态已经在重读时,成了照旧再读一次", async () => {
		const { qc } = renderBlocks([{ type: "button", label: "现在检查一次", action: "poll.now" }]);
		await waitFor(() => expect(statusReads()).toBe(1));
		const pending: Array<() => void> = [];
		vi.mocked(api.get).mockImplementation(
			() => new Promise((resolve) => pending.push(() => resolve({}))),
		);
		vi.mocked(api.post).mockImplementation(async () => {
			void qc.invalidateQueries({ queryKey: extensionStatusKey("douyin") });
			return { ok: true };
		});
		fireEvent.click(screen.getByRole("button", { name: "现在检查一次" }));
		await waitFor(() => expect(statusReads()).toBe(3));
		for (const release of pending) release();
	});

	it("回话说没成(ok: false)也算失败", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: false, err: "拓展 douyin 没在跑" });
		renderBlocks([{ type: "button", label: "现在检查一次", action: "poll.now" }]);
		fireEvent.click(screen.getByRole("button", { name: "现在检查一次" }));
		expect((await screen.findByRole("alert")).textContent).toContain("拓展 douyin 没在跑");
	});

	/** 「改设置」的按钮只挂在列表项上(决策 22),由列表那一层接;没人接就不画。 */
	it("改设置的按钮:没人接就不画", () => {
		renderBlocks([{ type: "button", label: "改成 AstrBot", set: { bridgeKind: "astrbot" } }]);
		expect(screen.queryByRole("button", { name: "改成 AstrBot" })).toBeNull();
	});

	it("改设置的按钮:有人接就把那一格交出去", () => {
		const onSet = vi.fn();
		renderBlocks([{ type: "button", label: "改成 AstrBot", set: { bridgeKind: "astrbot" } }], {
			onSet,
		});
		fireEvent.click(screen.getByRole("button", { name: "改成 AstrBot" }));
		expect(onSet).toHaveBeenCalledWith({ bridgeKind: "astrbot" });
		expect(api.post).not.toHaveBeenCalled();
	});
});
