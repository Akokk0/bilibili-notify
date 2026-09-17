// @vitest-environment jsdom

/**
 * 编辑器的实时预览栏(ADR-0014 决策 22)。
 *
 * 钉五条,各对应一个静默失败:① **iframe 只给同源、不给脚本** —— 皮肤里能写自定义
 * HTML/CSS,给了脚本就是让皮肤作者在主人面板里执行代码,而页面看上去一模一样(同源是为了
 * 量卡高,见 `SkinHtmlFrame`);
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

function renderPane(manifest: unknown = { v: 1 }, boxWidth = 600) {
	const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SkinPreviewPane
				skinId="neon"
				kind="live"
				scene="streaming"
				manifest={manifest}
				boxWidth={boxWidth}
			/>
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
	it("iframe 的 sandbox 只给同源 —— 不给脚本", async () => {
		renderPane();
		await tick();
		const f = frame();
		expect(f).not.toBeNull();
		// 写死整串:将来有人「顺手」再加一个 allow-* 时这条要红。同源 + 脚本 = 沙箱作废。
		expect(f?.getAttribute("sandbox")).toBe("allow-same-origin");
		expect(f?.getAttribute("sandbox")).not.toContain("allow-scripts");
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
				<SkinPreviewPane
					skinId="neon"
					kind="live"
					scene="streaming"
					manifest={{ v: 2 }}
					boxWidth={600}
				/>
			</QueryClientProvider>,
		);
		await tick();
		expect(vi.mocked(api.post).mock.calls.length).toBeGreaterThan(1);
	});

	it("这一栏比卡窄 → 整张按比例缩,iframe 里仍按卡的真实宽度排版", async () => {
		// 出图回的卡宽是 600(见 OK),栏只给 300。
		renderPane({ v: 1 }, 300);
		await tick();

		const el = frame() as HTMLIFrameElement;
		expect(el.style.width).toBe("600px");
		expect(el.style.transform).toBe("scale(0.5)");
		expect(screen.getByText(/50% 缩放/)).toBeTruthy();
	});

	it("栏比卡宽 → 就按卡宽画,不拉伸(拉伸出来的不是那张卡)", async () => {
		renderPane({ v: 1 }, 900);
		await tick();

		const el = frame() as HTMLIFrameElement;
		expect(el.style.width).toBe("600px");
		expect(el.style.transform).toBe("");
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
				<SkinPreviewPane
					skinId="neon"
					kind="live"
					scene="streaming"
					manifest={{ v: 9 }}
					boxWidth={600}
				/>
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
		// 这些不全是「清洗掉」的(还混着装包时的提醒),标题别说成全删了。
		expect(screen.getByText("存下去时有几处要留意:")).toBeTruthy();
	});
});

/**
 * 「最终效果」(ADR-0014 决策 22 的后半句)。实时预览是**看的人的浏览器**画的,推出去那张
 * 是 **server 上的 Chrome** 画的,字体渲染像素级对不上 —— 这颗按钮是作者唯一能看到真相的
 * 地方。
 *
 * 钉四条:① 没配 Chrome 时**禁掉并说清楚该去配什么**(不说的话主人只会觉得按钮坏了);
 * ② 截完切过去看的是那张图,不是 iframe;③ **草稿改了要说这张过期了** —— 悄悄挂着一张
 * 旧图,作者会拿它当「改完的样子」;④ 超过最大高度要说出来(出图那头会静默回落默认皮肤)。
 */
describe("皮肤预览栏 · 最终效果", () => {
	const SHOT = {
		ok: true,
		dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
		width: 600,
		height: 400,
		overHeight: false,
		warnings: [] as string[],
		scene: "streaming",
	};

	/** 预览走 `/preview`、截图走 `/skin-shot` —— 同一个 `api.post`,按 url 分流。 */
	function mockBoth(shot: Record<string, unknown> = SHOT): void {
		vi.mocked(api.post).mockImplementation(async (url: string) =>
			url.endsWith("/skin-shot") ? shot : OK,
		);
	}

	const shotBtn = () => screen.getByRole("button", { name: /最终效果/ }) as HTMLButtonElement;

	it("没配 Chrome → 钮禁着,并且说出该去配什么", async () => {
		mockBoth();
		vi.mocked(api.get).mockResolvedValue({ enabled: false, source: null, persistable: false });
		renderPane();
		await tick();

		expect(shotBtn().disabled).toBe(true);
		expect(screen.getByText(/BN_CHROME_PATH/)).toBeTruthy();
	});

	it("配了 Chrome → 按一下截一张,显示的是图不是 iframe", async () => {
		mockBoth();
		vi.mocked(api.get).mockResolvedValue({ enabled: true, source: null, persistable: false });
		renderPane();
		await tick();

		expect(shotBtn().disabled).toBe(false);
		await act(async () => {
			shotBtn().click();
		});
		await tick();

		const img = document.querySelector("img") as HTMLImageElement | null;
		expect(img?.getAttribute("src")).toBe(SHOT.dataUrl);
		expect(frame()).toBeNull();

		const [url, body] = vi.mocked(api.post).mock.calls.at(-1) as [string, Record<string, unknown>];
		expect(url).toBe("/api/cards/skin-shot");
		expect(body).toMatchObject({ skinId: "neon", kind: "live", scene: "streaming" });
	});

	it("长卡的截图整张摊开 → 不在一个限高的小窗里滚", async () => {
		mockBoth({ ...SHOT, height: 1800 });
		vi.mocked(api.get).mockResolvedValue({ enabled: true, source: null, persistable: false });
		renderPane();
		await tick();
		await act(async () => {
			shotBtn().click();
		});
		await tick();

		const img = document.querySelector("img") as HTMLImageElement;
		expect(img.parentElement?.style.maxHeight).toBe("");
		expect(img.parentElement?.className).not.toMatch(/overflow-(auto|y-)/);
	});

	it("草稿改了 → 那张图当场标成过期,别让人拿它当改完的样子", async () => {
		mockBoth();
		vi.mocked(api.get).mockResolvedValue({ enabled: true, source: null, persistable: false });
		const { rerender } = renderPane({ v: 1 });
		await tick();
		await act(async () => {
			shotBtn().click();
		});
		await tick();
		expect(screen.queryByText(/这张是上一版/)).toBeNull();

		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<SkinPreviewPane
					skinId="neon"
					kind="live"
					scene="streaming"
					manifest={{ v: 2 }}
					boxWidth={600}
				/>
			</QueryClientProvider>,
		);
		await tick();
		expect(screen.getByText(/这张是上一版/)).toBeTruthy();
	});

	it("超过最大高度 → 照样给看,但把「出图时会回落默认皮肤」说出来", async () => {
		mockBoth({ ...SHOT, height: 9999, overHeight: true });
		vi.mocked(api.get).mockResolvedValue({ enabled: true, source: null, persistable: false });
		renderPane();
		await tick();
		await act(async () => {
			shotBtn().click();
		});
		await tick();

		expect(screen.getByText(/回落/)).toBeTruthy();
	});
});
