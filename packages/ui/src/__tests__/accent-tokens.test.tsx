// @vitest-environment jsdom

/**
 * 带色件的 `accent` / `color` 必须收 `var(--color-bn-*)`。
 *
 * 这几个组件曾经用 `${accent}1f` 拼十六进制 alpha 后缀,于是**只能**传字面量 ——
 * 传 var() 会拼出 `var(--color-bn-pink)1f` 这种非法值,浏览器**静默丢弃整条声明**,
 * 卡片变成没底色没描边的裸块,而 typecheck 与 lint 都发现不了。代价是全站玻璃卡
 * 的角光、图标芯片、KPI 卡染色全被钉死在写死的十六进制上,皮肤换了主强调色也搬不动。
 *
 * 改用 `color-mix()` 之后限制没了。这条守卫钉住「没了」这件事:回退到字符串拼接
 * 不会让任何现有测试变红(hex 照样能拼),只有这里会。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Pill } from "../atoms";
import { GlassPanel, GlassStatCard } from "../glass";
import { GlassBox } from "../glass-box";

afterEach(cleanup);

/** 收集子树里所有内联 style 文本。 */
function styles(root: HTMLElement): string {
	return Array.from(root.querySelectorAll<HTMLElement>("[style]"))
		.map((el) => el.getAttribute("style") ?? "")
		.join(" | ");
}

const TOKEN = "var(--color-bn-pink)";

describe("accent / color 收 CSS 变量", () => {
	it("传 var() 不会被拼成 var(...)1f 这种非法值", () => {
		const { container } = render(
			<>
				<GlassBox title="盒" accent={TOKEN}>
					内容
				</GlassBox>
				<GlassPanel title="板" accent={TOKEN} icon={<span>i</span>}>
					内容
				</GlassPanel>
				<GlassStatCard label="卡" value="1" color={TOKEN} />
				<Pill color={TOKEN} subtle>
					药丸
				</Pill>
			</>,
		);
		const css = styles(container);
		// 拼接回归的特征:var(...) 后面直接跟两位十六进制。
		expect(/var\(--color-bn-pink\)[0-9a-f]{2}/.test(css)).toBe(false);
		expect(css).toContain("color-mix");
		expect(css).toContain(TOKEN);
	});

	it("十六进制照样收 —— 语义色 / 身份色仍传字面量", () => {
		const { container } = render(<GlassStatCard label="卡" value="1" color="#ef4444" />);
		const css = styles(container);
		expect(css).toContain("#ef4444");
		expect(css).toContain("color-mix");
	});

	it("默认强调色是 token 而不是写死的 B 站粉", () => {
		const { container } = render(
			<>
				<GlassBox title="盒">内容</GlassBox>
				<Pill subtle>药丸</Pill>
			</>,
		);
		const css = styles(container);
		expect(css).toContain(TOKEN);
		expect(css.toLowerCase()).not.toContain("#fb7299");
	});
});
