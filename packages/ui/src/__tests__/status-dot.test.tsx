// @vitest-environment jsdom

/**
 * `StatusDot` —— 8px 语义色状态点。
 *
 * 清单里写着它是「**语义色**状态点」,可七档颜色一直是手写的十六进制,一个 token 都
 * 不沾:皮肤配了 accent / success / warning / danger 四把刷子,刷不到这颗点上。而且
 * 那几个值和语义 token **对不齐** —— `ok` 是 green-500 而 `--color-bn-success` 是
 * emerald-500、`warn` 是 amber-500 而 warning token 是更深的 amber-600、`live` 更是
 * `#FF6699`(`config/push-kinds.ts` 的注释点名过的那条粉色漂移,token 是 `#fb7299`)。
 *
 * `Toggle` 已经走过一模一样的一遍并把理由写在了那儿:写死的话「全站每一颗开关的开
 * 都还是 B 站粉,皮肤换了主强调色也搬不动」。这颗点照那条判例办。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { StatusDot, type StatusDotKind } from "../atoms";

afterEach(cleanup);

const KINDS: StatusDotKind[] = ["live", "living", "off", "ok", "warn", "err", "pending"];

describe("StatusDot", () => {
	it("七档颜色全部走 token,一个十六进制字面量都不剩", () => {
		for (const kind of KINDS) {
			const { container } = render(<StatusDot kind={kind} />);
			const bg = (container.firstElementChild as HTMLElement).style.background;
			expect(bg, `${kind} 的底色`).toContain("var(--color-bn-");
			expect(bg, `${kind} 的底色`).not.toMatch(/#[0-9a-fA-F]{3}/);
			cleanup();
		}
	});

	it("直播那两档的呼吸光晕也从强调色现调,不写死粉色 rgba", () => {
		const { container } = render(<StatusDot kind="living" />);
		const shadow = (container.firstElementChild as HTMLElement).style.boxShadow;
		expect(shadow).toContain("var(--color-bn-pink)");
		expect(shadow).not.toContain("255");
	});

	it("只有直播那两档呼吸,其余六档是静的", () => {
		for (const kind of KINDS) {
			const { container } = render(<StatusDot kind={kind} />);
			const el = container.firstElementChild as HTMLElement;
			const blinking = el.className.includes("bn-anim-pulse");
			expect(blinking, kind).toBe(kind === "live" || kind === "living");
			cleanup();
		}
	});

	it("color 口盖过档位色 —— 逐项动态图例(模块 tone / 版式 accent)走这里", () => {
		// 收编前站内手写了四颗 6px 小圆点,className 逐字符相同、只有 background
		// 表达式各异 —— 那正是「逐项动态色」该由组件收口的形态。
		const { container } = render(<StatusDot color="var(--color-bn-blue)" />);
		const el = container.firstElementChild as HTMLElement;
		expect(el.style.background).toBe("var(--color-bn-blue)");
		expect(el.className).not.toContain("bn-anim-pulse");
	});

	it("size=sm 是 6px 图例档,md(默认)保持 8px", () => {
		const { container: sm } = render(<StatusDot kind="ok" size="sm" />);
		expect((sm.firstElementChild as HTMLElement).className).toContain("h-1.5 w-1.5");
		cleanup();
		const { container: md } = render(<StatusDot kind="ok" />);
		expect((md.firstElementChild as HTMLElement).className).toContain("h-2 w-2");
	});

	it("off 比 pending 浅 —— 两档都是灰,靠深浅分「关着的」和「等着的」", () => {
		// 收编前是 #cccccc vs #94a3b8。换成 token 之后这层次不能丢,否则两个状态
		// 在界面上就成了同一颗点。
		const { container: off } = render(<StatusDot kind="off" />);
		const offBg = (off.firstElementChild as HTMLElement).style.background;
		cleanup();
		const { container: pending } = render(<StatusDot kind="pending" />);
		const pendingBg = (pending.firstElementChild as HTMLElement).style.background;
		expect(offBg).toContain("--color-bn-text-disabled");
		expect(pendingBg).toContain("--color-bn-text-tertiary");
	});
});
