// @vitest-environment jsdom

/**
 * 拓展详情页的**页面级 tab**:配置 / 说明 / 更新日志。
 *
 * 文档曾经是直接摞在配置下面的,而说明动辄一整页 —— 于是更新日志被挤出视野,配置区也被
 * 一堵正文压着。三档并列之后每一档都从页面顶上开始。
 *
 * 值得钉的:① **默认停在配置** —— 点进来八成是来管接入的,不是来读说明的;② 没有的那档
 * 不摆(第三方不写 README 是它的自由),只剩一档时整条 tab 都不出现;③ 文档是第三方写的,
 * 走 `UNTRUSTED_MARKDOWN_COMPONENTS` 那副受限渲染,不是站内文档那副。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../services/api";
import ExtensionDetail from "../ExtensionDetail";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
		}
	}
	return { FakeApiError };
});

/** `value` 摆成 Error 就让这一发请求失败 —— 错误态和正常态共用这一个开关。 */
const { docs } = vi.hoisted(() => ({ docs: { value: {} as Record<string, unknown> | Error } }));

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url.endsWith("/docs")) {
				if (docs.value instanceof Error) throw docs.value;
				return docs.value;
			}
			return {
				extensions: [
					{
						id: "bridge",
						name: "机器人框架桥接",
						description: "借 bot",
						version: "0.0.1",
						enabled: false,
						state: "disabled",
					},
				],
			};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

vi.mock("../extensions/bridge-panel", () => ({
	BridgeAddressRow: () => <div />,
	BridgeConnections: () => <div />,
}));

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter initialEntries={["/extensions/bridge"]}>
			<QueryClientProvider client={qc}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("详情页上的拓展文档", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("有 README → 切过去画得出来", async () => {
		docs.value = { readme: "# 桥接\n\n把 koishi 的 bot 借过来。" };
		renderDetail();
		await openTab(/说明/);
		expect(await screen.findByText(/把 koishi 的 bot 借过来/)).toBeTruthy();
	});

	it("有 CHANGELOG → 也切得过去", async () => {
		docs.value = { changelog: "## [0.0.1]\n\n第一版。" };
		renderDetail();
		await openTab(/更新日志/);
		expect(await screen.findByText(/第一版/)).toBeTruthy();
	});

	/**
	 * 🔴 **「回上一级」得看得出来是能点的。** 那一格一直是粉色可点的,但只有颜色没有动作
	 * 提示 —— 主人反馈普通用户根本不知道点「拓展」两个字能返回。加一枚左箭头,一眼就是
	 * 「往回走」;那句话与这一页空态 / 错误态里的「回拓展列表」是同一个词。
	 */
	it("面包屑那一格有返回指示,并且真能回列表", async () => {
		docs.value = {};
		renderDetail();

		const back = await screen.findByRole("link", { name: /返回|回拓展/ });
		expect(back.getAttribute("href")).toBe("/extensions");
	});
});

/** 点进某一档文档 —— 默认停在配置,所以每条读文档的用例都要先切过去。 */
async function openTab(name: RegExp): Promise<void> {
	await userEvent.click(await screen.findByRole("tab", { name }));
}

describe("配置 / 说明 / 更新日志三档 tab", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	/** 🔴 来这一页八成是来管接入的 —— 拿一整页 README 迎面糊上去是本末倒置。 */
	it("默认停在配置,说明的正文还没画", async () => {
		docs.value = { readme: "# 桥接\n\n借 koishi 的 bot。", changelog: "## [0.0.1]\n\n第一版。" };
		renderDetail();

		const config = await screen.findByRole("tab", { name: /配置/ });
		expect(config.getAttribute("aria-selected")).toBe("true");
		expect(screen.queryByText(/借 koishi 的 bot/)).toBeNull();
		expect(screen.queryByText(/第一版/)).toBeNull();
	});

	it("点「说明」→ 画 README;再点「更新日志」→ 换成它", async () => {
		docs.value = { readme: "# 桥接\n\n借 koishi 的 bot。", changelog: "## [0.0.1]\n\n第一版。" };
		renderDetail();

		await openTab(/说明/);
		expect(await screen.findByText(/借 koishi 的 bot/)).toBeTruthy();

		await openTab(/更新日志/);
		expect(await screen.findByText(/第一版/)).toBeTruthy();
		expect(screen.queryByText(/借 koishi 的 bot/)).toBeNull();
	});

	/** 没写 README 就别摆一档点进去是空的。 */
	it("只带 CHANGELOG → 没有「说明」那一档", async () => {
		docs.value = { changelog: "## [0.0.1]\n\n第一版。" };
		renderDetail();

		expect(await screen.findByRole("tab", { name: /更新日志/ })).toBeTruthy();
		expect(screen.queryByRole("tab", { name: /说明/ })).toBeNull();
	});

	/** 一条只有一个按钮的 tab 条是噪音 —— 让人以为还有别的可点。 */
	it("两份文档都没有 → 整条 tab 都不出现,配置直接摊开", async () => {
		docs.value = {};
		renderDetail();

		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext/bridge/docs"));
		expect(screen.queryByRole("tab")).toBeNull();
	});
});

describe("读不到文档的时候", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	/**
	 * 🔴 装完那句话挂的「看看说明」凭的是服务端拆包时答好的 `docs.readme` —— 人点进来
	 * 却什么都没有的话,得到的结论是「说好有说明的,结果没有」,而真相可能只是这一刻
	 * 服务端在重启。仓里的规矩:失败的原因不许吞,更不许连那句话都不说。
	 */
	it("读挂了 → 把服务端那句话原样摆出来,还给一颗重试", async () => {
		docs.value = new FakeApiError(500, "上游炸了:ECONNRESET");
		renderDetail();
		expect(await screen.findByText(/ECONNRESET/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
	});

	/**
	 * 404 是**例外,它不是失败**:老服务端压根没有这条路由(应用内自更新那几秒,面板可能
	 * 比服务端新一版),或者这个拓展刚被删掉。两种都该安静。
	 */
	it("404 → 安静地整块不画,别摆一句吓人的错", async () => {
		docs.value = new FakeApiError(404, "没有这条路由");
		renderDetail();
		// ⚠️ 得**等着看它会不会冒出来**。第一版拿「`api.get` 被调过」当信号,那一刻请求
		// 才刚发出去、错误还没传到渲染,断言在什么都没发生的时候就通过了 —— 把 404 那条
		// 分支整个删掉它照样绿。`findByText` 会一直等到超时,这才是真的在守。
		await expect(screen.findByText(/读不到这个拓展的说明/)).rejects.toThrow();
	});
});

/**
 * 🔴 **这一组必须挂在详情页上,不能自己 new 一个 `<ReactMarkdown>` 来测。**
 *
 * 受限渲染是不是真的接在了这条路上,只有从**真调用点**量才算数:同样的三条断言写在
 * 组件的单测里(`components/__tests__/untrusted-markdown.test.tsx`),把 `docs-panel`
 * 换成 `dangerouslySetInnerHTML`(第三方 README 直进 DOM,最严重的那种回归)照样 8 条
 * 全绿 —— 因为那个文件从不 import `docs-panel`。仓里管这叫「接线要有自己的守卫」。
 *
 * 三条各钉一种回归:引了 `rehype-raw` / 改走 innerHTML / 换回站内文档那副映射
 * (那副没有 `img` 格、`a` 也无条件渲染 href)。
 */
describe("详情页画第三方内容时走的是受限渲染", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("README 里的裸 HTML 当字面文本,不变成节点", async () => {
		docs.value = { readme: '<img src=x onerror="alert(1)"> 后面还有字' };
		renderDetail();
		await openTab(/说明/);
		const para = await screen.findByText(/后面还有字/);
		expect(para.querySelector("img")).toBeNull();
		// 那段 HTML 得**原样念得出来**,否则它可能是被整段吞了而不是被转义了。
		expect(para.textContent).toContain("onerror");
	});

	it("README 里的 `javascript:` 链接不给 href —— 连 `<a>` 都不留", async () => {
		docs.value = { readme: "[点我](javascript:alert(1))" };
		renderDetail();
		await openTab(/说明/);
		const text = await screen.findByText(/点我/);
		// 只问「这段字在不在一个 <a> 里」—— 页面上本来就有面包屑等别的链接,
		// 拿 `document.querySelector("a")` 问会把它们一起抓进来。
		expect(text.closest("a")).toBeNull();
	});

	/**
	 * 表格是第三方 README 里最常见的结构(能力对照、平台支持),没有 GFM 就会逐行画成
	 * 字面的 `| a | b |`。而 `doc-markdown.tsx` 那副里 `table` / `th` / `td` 三格本来
	 * 就写好了 —— 不挂 GFM 的话它们在这条路上永远不可达,是三段死代码。
	 */
	it("README 里的表格画成真表格", async () => {
		docs.value = { readme: "| 平台 | 支持 |\n| --- | --- |\n| Telegram | 有 |" };
		renderDetail();
		await openTab(/说明/);
		expect(await screen.findByText("Telegram")).toBeTruthy();
		expect(document.querySelector("table")).not.toBeNull();
	});

	/** 相对路径脱离了源仓就拼不出地址,画出去是碎图、而且照样往面板自己身上发一次请求。 */
	it("README 里的相对路径图片退成占位,不渲染成 img", async () => {
		docs.value = { readme: "![流程图](docs/flow.png)" };
		renderDetail();
		await openTab(/说明/);
		// 占位是**看得见的字**;真画成 img 的话 alt 不算文本,这一句就找不着。
		const placeholder = await screen.findByText(/流程图 —— 见源站/);
		expect(placeholder.querySelector("img")).toBeNull();
	});
});
