// @vitest-environment jsdom
/**
 * 单元测试 —— Markdown chunk 已经到手之后,**第一帧**就得是排版好的。
 *
 * 主人报的那一下闪:开一个**新会话**,第一句回复流出来的瞬间,先是纯文本、紧接着
 * 翻成 Markdown。空闲预取早就把 chunk 取回来了,所以那不是网络 —— 是
 * `React.lazy` 自己的一帧:
 *
 *   lazy 的 init 要等到组件**第一次真被渲染**才跑。那时 `import()` 固然从缓存里拿,
 *   但拿回来的仍是个 promise,React 照样先抛它、提交一帧 Suspense fallback
 *   (而 fallback 正是纯文本),下个微任务才换成 Markdown。
 *
 * 有历史消息的会话里这一帧被面板入场动画盖住了,所以一直没露馅;新会话没有历史,
 * 第一次渲染发生在流式回复的正中间,主人正盯着那儿。
 *
 * 所以「Markdown 到手了没」不能是 Suspense 的挂起态,得是个能**同步**读出来的值。
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AiChatMessageDTO } from "../../../services/aiChat";

afterEach(cleanup);

function reply(content: string): AiChatMessageDTO {
	return { id: "m1", role: "assistant", content, ts: "2026-07-25T00:00:00.000Z" };
}

/**
 * 拿一份**冷的** messages 模块。
 *
 * 「Markdown 到手了没」是模块级(进程级)状态,不重置的话第二条用例会白捡第一条
 * 渲染时留下的成果 —— 第一版就是这么假绿的:实现还是 lazy,而它照样通过。
 *
 * `vi.resetModules()` 之后重新 import 到的 react 是同一份内部实现(实测:命名空间
 * 对象不同,但 `useState` 是同一个函数引用),所以不会撕出两个 React、hook 照常用。
 */
async function coldMessages() {
	vi.resetModules();
	return await import("../messages");
}

/**
 * 提交的**第一帧**,以可查询的 DOM 形式给出。
 *
 * 走单趟渲染再挂进一个游离节点,而不是直接对 HTML 字符串做 `toContain` ——
 * 断言里写死 `"<strong>"` 会被 `<strong class="font-bold">` 躲过去(第一版就这么
 * 红的),而这些 class 是渲染细节,不该由这条测试盯着。
 */
function firstFrame(node: ReactElement): HTMLElement {
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(node);
	return host;
}

describe("Markdown 首帧", () => {
	/**
	 * 查第一帧只能用**单趟渲染**。
	 *
	 * 一开始我拿 RTL 的 `render` 查,结果是假绿:`render` 裹在 `act()` 里,effect 引起的
	 * 那次重渲染在它返回之前就冲洗完了 —— 我把「已到手的模块故意慢一帧才用」这个
	 * 退化改进去做破坏性验证,四条测试全绿。而在真浏览器里 passive effect 跑在绘制
	 * **之后**,慢一帧就是实打实闪一下。
	 *
	 * `renderToStaticMarkup` 只渲染一趟、不跑 effect、不进 act,拿到的就是提交的第一帧。
	 */
	it("预取完成后,落盘消息第一帧就出 <strong> —— 不许先闪一帧纯文本", async () => {
		const { MessageList, preloadChatMarkdown } = await coldMessages();
		await preloadChatMarkdown(); // 等价于「空闲预取已经跑完了」
		const frame = firstFrame(
			<MessageList messages={[reply("她说 **加粗** 了")]} busy={false} aiSelf="小绫" />,
		);
		expect(frame.querySelector("strong")).toBeTruthy();
	});

	it("在途那半截同样第一帧就排版好 —— 新会话的闪就闪在这儿", async () => {
		const { MessageList, preloadChatMarkdown } = await coldMessages();
		await preloadChatMarkdown();
		const frame = firstFrame(
			<MessageList
				messages={[]}
				pending={{ ask: "你好", draft: "- 甲\n- 乙", tools: [], think: "" }}
				busy
				aiSelf="小绫"
			/>,
		);
		expect(frame.querySelectorAll("li")).toHaveLength(2);
	});

	it("没预取过也自己去取:第一帧纯文本(字不丢),落地后翻成 Markdown", async () => {
		// 这条既守退化路径,也守「没人预热时不会永远停在纯文本」。
		const { MessageList } = await coldMessages();
		const { container } = render(
			<MessageList messages={[reply("她说 **加粗** 了")]} busy={false} aiSelf="小绫" />,
		);
		expect(container.querySelector("strong")).toBeNull();
		expect(container.textContent).toContain("加粗");
		await waitFor(() => expect(container.querySelector("strong")).toBeTruthy());
	});

	it("chunk 取不到就一直用纯文本 —— 不许整个聊天白屏", async () => {
		// 挂在 lazy 上时这儿没有 error boundary:离线、或部署换版本后旧 chunk 404,
		// 就是整个聊天界面白屏。
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			vi.resetModules();
			vi.doMock("../markdown", () => {
				throw new Error("chunk 404");
			});
			const { MessageList } = await import("../messages");
			const { container } = render(
				<MessageList messages={[reply("她说 **加粗** 了")]} busy={false} aiSelf="小绫" />,
			);
			await waitFor(() => expect(err).toHaveBeenCalled());
			expect(container.textContent).toContain("加粗");
			expect(container.querySelector("strong")).toBeNull();
		} finally {
			vi.doUnmock("../markdown");
			err.mockRestore();
		}
	});
});
