// @vitest-environment jsdom
/**
 * 卡片 HTML 的隔离预览框 —— **换内容时不许在同一个 iframe 上改 `srcdoc`**。
 *
 * 2026-09-17 真机反馈:聊天里的卡片预览切几次卡种,「返回控制台」就得点几次。在已经插进
 * 页面的 iframe 上改 `srcdoc` 是一次子框导航,浏览器把它记进整页的历史;`navigate(-1)`
 * 先退掉的是 iframe 里那几条,页面纹丝不动。新插入的 iframe,首次导航是替换它的初始
 * 空白页,不占历史 —— 所以每份新 HTML 换一个新框。
 *
 * jsdom 不模拟联合历史,这里钉的是那条**性质**:已插入的 iframe,`srcdoc` 一次都不改。
 * 另一条是编辑器那边的老规矩:新的那份画好之前,旧图不撤(闪白比慢半拍难受)。
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SkinHtmlFrame } from "../SkinHtmlFrame";

const frame = (html: string) => (
	<SkinHtmlFrame html={html} width={600} usable={600} height={400} title="预览" />
);

const iframes = (root: HTMLElement) => [...root.querySelectorAll("iframe")];
const visibleOnes = (root: HTMLElement) =>
	iframes(root).filter((f) => !f.className.includes("invisible"));

afterEach(cleanup);

describe("SkinHtmlFrame", () => {
	it("换了一份 HTML → 换一个新框;已插入的框,srcdoc 一次都不改", () => {
		const view = render(frame("<p>直播卡</p>"));
		const changed: string[] = [];
		const watch = new MutationObserver((records) => {
			for (const r of records) if (r.attributeName === "srcdoc") changed.push(r.type);
		});
		watch.observe(view.container, { subtree: true, attributes: true });

		const first = iframes(view.container)[0];
		fireEvent.load(first as HTMLIFrameElement);
		view.rerender(frame("<p>动态卡</p>"));
		view.rerender(frame("<p>上舰卡</p>"));
		watch.takeRecords().forEach((r) => {
			if (r.attributeName === "srcdoc") changed.push(r.type);
		});
		watch.disconnect();

		expect(changed).toEqual([]);
		expect(iframes(view.container).map((f) => f.getAttribute("srcdoc"))).toContain("<p>上舰卡</p>");
	});

	it("新的那份画好之前旧图还露着;画好了换过去,旧框撤掉", () => {
		const view = render(frame("<p>直播卡</p>"));
		const first = iframes(view.container)[0] as HTMLIFrameElement;
		fireEvent.load(first);
		expect(visibleOnes(view.container)).toEqual([first]);

		view.rerender(frame("<p>动态卡</p>"));
		const next = iframes(view.container).find(
			(f) => f.getAttribute("srcdoc") === "<p>动态卡</p>",
		) as HTMLIFrameElement;
		expect(next).not.toBe(first);
		expect(visibleOnes(view.container)).toEqual([first]);

		fireEvent.load(next);
		expect(iframes(view.container)).toEqual([next]);
		expect(visibleOnes(view.container)).toEqual([next]);
	});

	it("每一个框都是空 sandbox", () => {
		const view = render(frame("<p>直播卡</p>"));
		fireEvent.load(iframes(view.container)[0] as HTMLIFrameElement);
		view.rerender(frame("<p>动态卡</p>"));
		const all = iframes(view.container);
		expect(all).toHaveLength(2);
		for (const f of all) expect(f.getAttribute("sandbox")).toBe("");
	});
});
