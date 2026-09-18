// @vitest-environment jsdom
/**
 * 卡片 HTML 的隔离预览框。钉三件事:
 *
 * 1. **换内容时不许在同一个 iframe 上改 `srcdoc`**。2026-09-17 真机反馈:聊天里的卡片预览
 *    切几次卡种,「返回控制台」就得点几次。在已经插进页面的 iframe 上改 `srcdoc` 是一次子框
 *    导航,浏览器把它记进整页的历史;新插入的 iframe,首次导航是替换它的初始空白页,不占
 *    历史 —— 所以每份新 HTML 换一个新框。jsdom 不模拟联合历史,这里钉的是那条**性质**:
 *    已插入的 iframe,`srcdoc` 一次都不改。另一条是编辑器那边的老规矩:新的那份画好之前,
 *    旧图不撤(闪白比慢半拍难受)。
 * 2. **框跟着卡高**(同日主人反馈:卡长了编辑器里出滚动条)。量的是框里文档根的高度 ——
 *    与截图裁图量的是同一个元素。jsdom 不排版,文档由这里伪造。
 * 3. **sandbox 只给同源、不给脚本**。同源是为了量高;脚本一给,皮肤作者就能在主人面板里
 *    跑代码,而同源 + 脚本等于整个沙箱作废。
 * 4. **画好了把文档交出去**(2026-09-18:画布要知道这一场真画出了哪些块)。只交 `load`
 *    那一次 —— 块画不画由数据与 `showIf` 定,字体到齐只改排版、不会让谁凭空出现或消失。
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SkinHtmlFrame } from "../SkinHtmlFrame";

const FALLBACK = 400;

const frame = (html: string, usable = 600) => (
	<SkinHtmlFrame html={html} width={600} usable={usable} fallbackHeight={FALLBACK} title="预览" />
);

const iframes = (root: HTMLElement) => [...root.querySelectorAll("iframe")];
const visibleOnes = (root: HTMLElement) =>
	iframes(root).filter((f) => !f.className.includes("invisible"));
const withDoc = (root: HTMLElement, html: string) =>
	iframes(root).find((f) => f.getAttribute("srcdoc") === html) as HTMLIFrameElement;
/** 外框(量出来的高度落在它身上)。 */
const box = (root: HTMLElement) => root.firstElementChild as HTMLElement;

/**
 * 让一个框「画好了」:它的文档根量出来 `size.height` 高,再发 `load`。`size` 是活的,
 * 字体晚到那条靠改它模拟「重排之后变高了」。`doc: null` = 读不到文档。
 */
function loaded(
	f: HTMLIFrameElement,
	size: { height: number } | null,
	fonts?: Promise<unknown>,
): unknown {
	const doc =
		size === null
			? null
			: {
					documentElement: { getBoundingClientRect: () => ({ height: size.height }) },
					...(fonts ? { fonts: { ready: fonts } } : {}),
				};
	Object.defineProperty(f, "contentDocument", { configurable: true, get: () => doc });
	fireEvent.load(f);
	return doc;
}

afterEach(cleanup);

describe("SkinHtmlFrame · 换内容", () => {
	it("换了一份 HTML → 换一个新框;已插入的框,srcdoc 一次都不改", () => {
		const view = render(frame("<p>直播卡</p>"));
		const changed: string[] = [];
		const watch = new MutationObserver((records) => {
			for (const r of records) if (r.attributeName === "srcdoc") changed.push(r.type);
		});
		watch.observe(view.container, { subtree: true, attributes: true });

		loaded(iframes(view.container)[0] as HTMLIFrameElement, { height: 300 });
		view.rerender(frame("<p>动态卡</p>"));
		view.rerender(frame("<p>上舰卡</p>"));
		watch.takeRecords().forEach((r) => {
			if (r.attributeName === "srcdoc") changed.push(r.type);
		});
		watch.disconnect();

		expect(changed).toEqual([]);
		expect(iframes(view.container).map((f) => f.getAttribute("srcdoc"))).toContain("<p>上舰卡</p>");
	});

	it("新的那份画好之前旧图还露着、外框还是旧卡的高;画好了一起换过去,旧框撤掉", () => {
		const view = render(frame("<p>直播卡</p>"));
		const first = iframes(view.container)[0] as HTMLIFrameElement;
		loaded(first, { height: 1000 });
		expect(visibleOnes(view.container)).toEqual([first]);
		expect(box(view.container).style.height).toBe("1000px");

		view.rerender(frame("<p>动态卡</p>"));
		const next = withDoc(view.container, "<p>动态卡</p>");
		expect(next).not.toBe(first);
		expect(visibleOnes(view.container)).toEqual([first]);
		expect(box(view.container).style.height).toBe("1000px");

		loaded(next, { height: 300 });
		expect(iframes(view.container)).toEqual([next]);
		expect(visibleOnes(view.container)).toEqual([next]);
		expect(box(view.container).style.height).toBe("300px");
	});
});

describe("SkinHtmlFrame · 高度", () => {
	it("画好了 → 框跟着卡高,缩放时外框按比例折算;没量到之前先占固定视口", () => {
		const view = render(frame("<p>九图动态</p>", 300));
		expect(box(view.container).style.height).toBe(`${FALLBACK}px`);

		const f = iframes(view.container)[0] as HTMLIFrameElement;
		loaded(f, { height: 1234.4 });
		// 小数往上取:视口比内容矮半个像素,框里就又出滚动条了。
		expect(f.style.height).toBe("1235px");
		// 卡宽 600 挤进 300 → 缩一半。
		expect(box(view.container).style.height).toBe("618px");
	});

	it("字体晚到把卡撑高了 → 再量一次跟上", async () => {
		let fontsDone = () => {};
		const fonts = new Promise<void>((r) => {
			fontsDone = r;
		});
		const view = render(frame("<p>直播卡</p>"));
		const f = iframes(view.container)[0] as HTMLIFrameElement;
		const size = { height: 500 };
		loaded(f, size, fonts);
		expect(box(view.container).style.height).toBe("500px");

		size.height = 560;
		await act(async () => {
			fontsDone();
			await fonts;
		});
		expect(f.style.height).toBe("560px");
		expect(box(view.container).style.height).toBe("560px");
	});

	it("旧框的字体晚到时已经换成新卡了 → 不去动新卡的高", async () => {
		let fontsDone = () => {};
		const fonts = new Promise<void>((r) => {
			fontsDone = r;
		});
		const view = render(frame("<p>直播卡</p>"));
		const size = { height: 500 };
		loaded(iframes(view.container)[0] as HTMLIFrameElement, size, fonts);

		view.rerender(frame("<p>动态卡</p>"));
		const next = withDoc(view.container, "<p>动态卡</p>");
		loaded(next, { height: 300 });
		expect(box(view.container).style.height).toBe("300px");
		// jsdom 插入 iframe 后会**异步**补发一次它自己的 `load`。先让它发完 —— 不然它晚到
		// 一步,正好把「被旧框改回去」的 ready 又改回新卡,这条就为错误的理由绿了。
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		size.height = 560;
		await act(async () => {
			fontsDone();
			await fonts;
		});
		expect(visibleOnes(view.container)).toEqual([next]);
		expect(box(view.container).style.height).toBe("300px");
	});

	it("量不到(读不到文档)→ 退回固定视口,卡在框里滚", () => {
		const view = render(frame("<p>直播卡</p>", 300));
		const f = iframes(view.container)[0] as HTMLIFrameElement;
		loaded(f, null);
		expect(visibleOnes(view.container)).toEqual([f]);
		expect(box(view.container).style.height).toBe(`${FALLBACK}px`);
		// 缩一半时,框里的视口是外框的两倍高,缩回来正好填满外框。
		expect(f.style.height).toBe(`${FALLBACK * 2}px`);
	});
});

describe("SkinHtmlFrame · 交出文档", () => {
	const frameWith = (html: string, onDocument: (doc: Document) => void) => (
		<SkinHtmlFrame
			html={html}
			width={600}
			usable={600}
			fallbackHeight={FALLBACK}
			title="预览"
			onDocument={onDocument}
		/>
	);

	it("画好了 → 把框里的文档交出去", () => {
		const got: unknown[] = [];
		const view = render(frameWith("<p>直播卡</p>", (d) => got.push(d)));
		const doc = loaded(iframes(view.container)[0] as HTMLIFrameElement, { height: 300 });
		expect(got).toEqual([doc]);
	});

	it("换一份 HTML → 交的是新那份的文档", () => {
		const got: unknown[] = [];
		const view = render(frameWith("<p>直播卡</p>", (d) => got.push(d)));
		loaded(iframes(view.container)[0] as HTMLIFrameElement, { height: 300 });
		view.rerender(frameWith("<p>动态卡</p>", (d) => got.push(d)));
		const next = withDoc(view.container, "<p>动态卡</p>");
		const fresh = loaded(next, { height: 200 });
		expect(got.at(-1)).toBe(fresh);
		expect(got).toHaveLength(2);
	});

	it("读不到文档 → 什么都不交,画布一个块都不淡", () => {
		const got: unknown[] = [];
		const view = render(frameWith("<p>直播卡</p>", (d) => got.push(d)));
		loaded(iframes(view.container)[0] as HTMLIFrameElement, null);
		expect(got).toEqual([]);
	});
});

describe("SkinHtmlFrame · 沙箱", () => {
	it("每一个框都只给同源、不给脚本", () => {
		const view = render(frame("<p>直播卡</p>"));
		loaded(iframes(view.container)[0] as HTMLIFrameElement, { height: 300 });
		view.rerender(frame("<p>动态卡</p>"));
		const all = iframes(view.container);
		expect(all).toHaveLength(2);
		for (const f of all) expect(f.getAttribute("sandbox")).toBe("allow-same-origin");
	});
});
