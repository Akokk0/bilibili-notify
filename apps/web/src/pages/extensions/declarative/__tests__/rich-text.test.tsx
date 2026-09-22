// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://192.168.1.20:8787/extensions/douyin"}

/**
 * 富文本的五种片段(ADR-0019 决策 28):字、`{ b }`、`{ mono }`、`{ time, suffix }`、
 * `{ host: "extensionUrl" }`。
 *
 * 值得钉的:① 时刻**在浏览器里**按相对时间画 —— 服务端算好的「12 分钟前」发到面板就冻住了;
 * ② 地址**在浏览器里**现算,用的是地址栏的 host(这个文件把 jsdom 的地址定在一台内网机器上,
 * 所以期望值是一个写死的字面量,不是照着实现再算一遍);③ 没有 HTML —— 拓展交来的字里带
 * 尖括号,画出来的就是尖括号。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RichText } from "../rich-text";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

describe("RichText", () => {
	beforeEach(() => {
		// 只假时钟,不假定时器 —— 这一摞都是同步渲染,用不着推时间。
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("一个字符串原样画", () => {
		const { container } = render(<RichText text="cookie 有效" extensionId="douyin" />);
		expect(container.textContent).toBe("cookie 有效");
	});

	it("加粗与等宽各是自己的元素", () => {
		const { container } = render(
			<RichText
				text={["这是", { b: "桥那台机器" }, "要访问得到的地址,别填 ", { mono: "127.0.0.1" }]}
				extensionId="bridge"
			/>,
		);
		expect(container.textContent).toBe("这是桥那台机器要访问得到的地址,别填 127.0.0.1");
		const strong = container.querySelector("strong");
		expect(strong?.textContent).toBe("桥那台机器");
		expect(strong?.className).toContain("font-bold");
		const mono = [...container.querySelectorAll(".font-mono")].map((el) => el.textContent);
		expect(mono).toEqual(["127.0.0.1"]);
	});

	/**
	 * 🔴 时刻在浏览器里算:服务端交的是毫秒数,面板照「现在」画。十二分钟前的那一刻,
	 * 接上 suffix 就是「12 分钟前连上」。
	 */
	it("时刻画成相对时间,后面接 suffix", () => {
		const { container } = render(
			<RichText text={[{ time: NOW - 12 * 60_000, suffix: "连上" }]} extensionId="bridge" />,
		);
		expect(container.textContent).toBe("12 分钟前连上");
	});

	/** 时刻越过 Date 能表示的范围(宿主只卡了下限)也不许把整段字带走。 */
	it("离谱的时刻不炸", () => {
		const { container } = render(
			<RichText text={["上次 ", { time: 9e18, suffix: "检查" }]} extensionId="douyin" />,
		);
		expect(container.textContent).toContain("上次 ");
		expect(container.textContent).toContain("检查");
	});

	it("时刻没有 suffix 就只画时间", () => {
		const { container } = render(
			<RichText text={["上次检查 ", { time: NOW - 3 * 3_600_000 }]} extensionId="douyin" />,
		);
		expect(container.textContent).toBe("上次检查 3 小时前");
	});

	/**
	 * 🔴 地址由浏览器现算:`ws://<地址栏的 host>/ext/<id>`。服务端不知道外面经哪个地址访问它,
	 * 而那正是桥那台机器要填的。
	 */
	it("host 片段画成这个拓展经地址栏算出来的地址,等宽", () => {
		const { container } = render(
			<RichText text={["插件那头要填 ", { host: "extensionUrl" }]} extensionId="bridge" />,
		);
		expect(container.textContent).toBe("插件那头要填 ws://192.168.1.20:8787/ext/bridge");
		expect(container.querySelector(".font-mono")?.textContent).toBe(
			"ws://192.168.1.20:8787/ext/bridge",
		);
	});

	/** 🔴 没有 HTML:拓展交来的字里带标签,画出来的是字面上的尖括号,不是元素。 */
	it("字里的标签原样当字画,不变成元素", () => {
		const evil = '<img src=x onerror="alert(1)"><b>粗</b>';
		const { container } = render(
			<RichText text={[evil, { b: evil }, { mono: evil }]} extensionId="douyin" />,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("b")).toBeNull();
		expect(container.textContent).toBe(evil.repeat(3));
	});

	/** 宿主校验过,但面板不该因为一片认不出的片段整页白屏 —— 认不出的就不画。 */
	it("认不出的片段跳过,其余照画", () => {
		const { container } = render(
			<RichText text={["前", { script: "alert(1)" } as never, "后"]} extensionId="douyin" />,
		);
		expect(container.textContent).toBe("前后");
	});
});
