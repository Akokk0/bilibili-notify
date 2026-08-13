// @vitest-environment jsdom
/**
 * 会话级两颗胶囊(深度思考/联网搜索)的归零策略。
 *
 * 「换个会话就归零」是主人定的;但 activeId 的变化有两种来路:
 * ① 用户切换/新建会话 —— 该归零;
 * ② **首发消息落地新会话**(空态直接打字,mutationFn 先 createConversation
 *   再 setActiveId)—— 这不是换会话,用户刚点亮的胶囊要是在按下发送那一刻
 *   被打回 false,界面上开关当着他的面熄灭,同一会话的后续消息还全部静默
 *   不思考/不搜索。② 曾经跟 ① 走同一个 effect,正是审查抓到的 bug。
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { useSessionCapsules } from "../use-session-capsules";

describe("useSessionCapsules", () => {
	it("用户切换会话 → 两颗胶囊归零", () => {
		const view = renderHook(({ id }) => useSessionCapsules(id), {
			initialProps: { id: "a" as string | null },
		});
		act(() => {
			view.result.current.setThinkingOn(true);
			view.result.current.setSearchOn(true);
		});
		view.rerender({ id: "b" });
		expect(view.result.current.thinkingOn).toBe(false);
		expect(view.result.current.searchOn).toBe(false);
	});

	it("首发落地新会话(adoptConversation)→ 胶囊保持点亮", () => {
		const view = renderHook(({ id }) => useSessionCapsules(id), {
			initialProps: { id: null as string | null },
		});
		act(() => {
			view.result.current.setThinkingOn(true);
		});
		// mutationFn 里的顺序:先声明「这次是收养,不是换会话」,再 setActiveId。
		act(() => {
			view.result.current.adoptConversation();
		});
		view.rerender({ id: "fresh" });
		expect(view.result.current.thinkingOn).toBe(true);
	});

	it("收养只豁免一次 —— 之后再换会话照样归零", () => {
		const view = renderHook(({ id }) => useSessionCapsules(id), {
			initialProps: { id: null as string | null },
		});
		act(() => {
			view.result.current.setThinkingOn(true);
			view.result.current.adoptConversation();
		});
		view.rerender({ id: "fresh" });
		expect(view.result.current.thinkingOn).toBe(true);
		view.rerender({ id: "other" });
		expect(view.result.current.thinkingOn).toBe(false);
	});
});
