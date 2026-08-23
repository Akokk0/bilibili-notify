// @vitest-environment jsdom

/**
 * `Btn` 的 `danger-outline` 档 —— 带**红描边**的危险小钮。
 *
 * 站里有两处手写它:Ai 页的「删除服务商 / 删除性格」、字体选择器的「清除」。库里
 * `danger` 那档是**透明边**的纯红字钮,套不上;于是两处各写各的,一个虚线边一个实线边、
 * 一个 11.5px 一个 11px、hover 一个染底一个换边色 —— 同一个意思三处不一样。
 *
 * 与 `outline`(中性描边)是同一档的两个语义,所以名字取成它的兄弟。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Btn } from "../atoms";

afterEach(cleanup);

const cls = (name: string) => screen.getByRole("button", { name }).className;

describe("Btn danger-outline", () => {
	it("有红描边 —— 这正是它与 danger 那档的唯一区别", () => {
		render(
			<>
				<Btn variant="danger">纯红字</Btn>
				<Btn variant="danger-outline">带描边</Btn>
			</>,
		);
		expect(cls("带描边")).toContain("border-bn-danger-border");
		// 对照:danger 那档是透明边,不该因为这次新增而被改掉。
		expect(cls("纯红字")).toContain("border-transparent");
	});

	it("底是透明的,不是实心红 —— 行内小钮不该有实心底的分量(实心红是 danger-solid 的档)", () => {
		render(<Btn variant="danger-outline">删除</Btn>);
		const c = cls("删除");
		expect(c).toContain("bg-transparent");
		expect(c).not.toContain("bg-bn-danger ");
		expect(c).not.toContain("text-bn-on-solid");
	});

	it("照样挂 btn 挂点,且不是主按钮", () => {
		render(<Btn variant="danger-outline">删除</Btn>);
		expect(screen.getByRole("button", { name: "删除" }).getAttribute("data-bn")).toBe("btn");
	});
});
