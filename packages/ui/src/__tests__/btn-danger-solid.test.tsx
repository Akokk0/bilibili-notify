// @vitest-environment jsdom

/**
 * `Btn` 的 `danger-solid` 档 —— 确认弹窗里那颗实心红底的「确认销毁」钮。
 *
 * 旧规矩「danger 不做实心语义底」针对的技术雷是**写死的 `text-white` 皮肤够不着**,
 * 实底被皮肤刷浅后白字隐形(About 爱发电按钮的车)。`--color-bn-on-solid` token 立起来
 * 之后,前景也归皮肤管,雷拆掉一半;剩下的要求收敛成一条 —— **实心语义底必须入主按钮
 * 池**(挂 `btn-primary`):皮肤给 `btn` 刷的是中性底,只有 `btn-primary` 档会把强调实底
 * 盖回来,单挂 `btn` 的实心钮在皮肤下就是「中性底 + 实底前景」的打架现场。
 *
 * 于是三个实心档(primary / blue / danger-solid)一律双挂点;透明底的档保持单挂 `btn`。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Btn } from "../atoms";

afterEach(cleanup);

const btn = (name: string) => screen.getByRole("button", { name });

describe("Btn danger-solid", () => {
	it("实心红底 + on-solid 前景 token,不写死白字", () => {
		render(<Btn variant="danger-solid">确认移除</Btn>);
		const c = btn("确认移除").className;
		expect(c).toContain("bg-bn-danger ");
		expect(c).toContain("text-bn-on-solid");
		expect(c).not.toContain("text-white");
	});

	it("入主按钮池:挂 btn btn-primary 双挂点", () => {
		render(<Btn variant="danger-solid">确认移除</Btn>);
		expect(btn("确认移除").getAttribute("data-bn")).toBe("btn btn-primary");
	});

	it("blue 也是实心底,同池同挂法", () => {
		render(<Btn variant="blue">实心蓝</Btn>);
		expect(btn("实心蓝").getAttribute("data-bn")).toBe("btn btn-primary");
	});

	it("对照:透明底的档不进主按钮池", () => {
		render(
			<>
				<Btn variant="danger">纯红字</Btn>
				<Btn variant="danger-outline">红描边</Btn>
				<Btn variant="outline">中性描边</Btn>
			</>,
		);
		for (const name of ["纯红字", "红描边", "中性描边"]) {
			expect(btn(name).getAttribute("data-bn")).toBe("btn");
		}
	});
});
