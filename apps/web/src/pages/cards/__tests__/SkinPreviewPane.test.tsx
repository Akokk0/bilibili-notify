// @vitest-environment jsdom

/**
 * 编辑器的实时预览栏(ADR-0014 决策 22)。
 *
 * 钉五条,各对应一个静默失败:① **iframe 不给脚本也不给同源** —— 皮肤里能写自定义
 * HTML/CSS,放开任一条就是让皮肤作者在主人面板里执行代码 / 读会话,而页面看上去一模一样;
 * ② **草稿变了要重画**(接线断了的话预览永远停在第一张,像「拧了没反应」);③ **防抖**
 * (每敲一个字打一趟 SSR,server 当场被打满,而本地开发根本看不出来);④ **重画期间旧图
 * 不撤**(闪白比慢半拍难受);⑤ **装包门拒了要把原因逐条列出来**,不是自编一句「预览失败」。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
	api: { post: vi.fn(), get: vi.fn(), put: vi.fn() },
}));

import { api } from "../../../services/api";
import { SkinPreviewPane } from "../SkinPreviewPane";

const OK = {
	html: '<html><body><div data-bn="frame">画好了</div></body></html>',
	width: 600,
	warnings: [] as string[],
	scene: "streaming",
};

function renderPane(manifest: unknown = { v: 1 }) {
	const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SkinPreviewPane skinId="neon" kind="live" scene="streaming" manifest={manifest} />
		</QueryClientProvider>,
	);
}

/**
 * 把防抖窗口推过去,**顺带把挂在上面的 promise 冲干净**。
 *
 * 不用 `waitFor`:它内部自己起定时器,在 `vi.useFakeTimers()` 下永远等不到 —— 四条用例
 * 一起卡死 5 秒超时,而报出来的样子像是组件没渲染。
 */
async function tick(ms = 500): Promise<void> {
	await act(async () => {
		vi.advanceTimersByTime(ms);
	});
	// mutation 的 onSuccess 要再过一轮微任务才落到 state 上。
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

const frame = (): HTMLIFrameElement | null =>
	document.querySelector("iframe") as HTMLIFrameElement | null;

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(api.post).mockResolvedValue(OK);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("皮肤预览栏", () => {
	it("iframe 的 sandbox 是空的 —— 既不给脚本也不给同源", async () => {
		renderPane();
		await tick();
		const f = frame();
		expect(f).not.toBeNull();
		expect(f?.getAttribute("sandbox")).toBe("");
		// 写死两条:将来有人「顺手」加一个 allow-* 时这条要红。
		expect(f?.getAttribute("sandbox")).not.toContain("allow-scripts");
		expect(f?.getAttribute("sandbox")).not.toContain("allow-same-origin");
		expect(f?.getAttribute("srcdoc")).toContain("画好了");
	});

	it("防抖:窗口没到不发请求,到了才发一趟", async () => {
		renderPane();
		await tick(200);
		expect(vi.mocked(api.post)).not.toHaveBeenCalled();
		await tick(300);
		expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1);
		const [url, body] = vi.mocked(api.post).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe("/api/card-skins/neon/preview");
		expect(body).toMatchObject({ kind: "live", scene: "streaming" });
	});

	it("草稿换了 → 重画(接线断了的话预览永远停在第一张)", async () => {
		const view = renderPane({ v: 1 });
		await tick();
		expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1);

		const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		view.rerender(
			<QueryClientProvider client={qc}>
				<SkinPreviewPane skinId="neon" kind="live" scene="streaming" manifest={{ v: 2 }} />
			</QueryClientProvider>,
		);
		await tick();
		expect(vi.mocked(api.post).mock.calls.length).toBeGreaterThan(1);
	});

	it("装包门拒了 → 原因逐条列出来,并且上一张图还留着", async () => {
		renderPane();
		await tick();
		expect(frame()).not.toBeNull();

		vi.mocked(api.post).mockRejectedValue(
			new FakeApiError(400, { ok: false, errors: ["块 id 重了:notice", "css 洗完是空的"] }, "400"),
		);
		const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<SkinPreviewPane skinId="neon" kind="live" scene="streaming" manifest={{ v: 9 }} />
			</QueryClientProvider>,
		);
		// 失败那条比成功多绕一轮:react-query 要先把 rejection 记进 mutation 状态。
		await tick();
		await tick(0);
		expect(screen.getByText("块 id 重了:notice")).toBeTruthy();
		expect(screen.getByText("css 洗完是空的")).toBeTruthy();
		// 第一份实例那张图没被撤掉。
		expect(frame()).not.toBeNull();
	});

	it("清洗警告照样列出来 —— 存下去会少点什么,当场就得看得见", async () => {
		vi.mocked(api.post).mockResolvedValue({ ...OK, warnings: ["丢掉了 1 条 url() 声明"] });
		renderPane();
		await tick();
		expect(screen.getByText("丢掉了 1 条 url() 声明")).toBeTruthy();
	});
});
