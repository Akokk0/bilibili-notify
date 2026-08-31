// @vitest-environment jsdom

/**
 * 三个按钮档共同的一条契约:**原生 `data-*` 原样落到真实 `<button>` 上**。
 *
 * 消费方靠它给控件贴外部标记(目前是新手导览的 `data-tour` 灯位)。曾经只有
 * `AddButton` / `AddCard` 开了这条口子,`Btn` 没开 —— 于是导览给按钮包了一层
 * `<span data-tour>`,同一件事有了三种写法,而聚光灯量到的是那层 span 的矩形。
 *
 * 顺带钉住**覆盖不掉 `data-bn`**:皮肤挂点是库的地盘,外面传进来的属性铺在
 * 前面,库自己那几个写在后面。挂点被顶掉的症状是「装了皮肤后这颗按钮隐形」,
 * 而且构建全绿,只有真机露馅。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AddButton, AddCard, Btn } from "../index";

afterEach(cleanup);

const btn = () => screen.getByRole("button");

describe("data-* 透传", () => {
	it("Btn 把 data-* 交给真实 button,且不动 data-bn", () => {
		render(
			<Btn data-tour="bili-login" data-bn="btn-hijacked">
				发起扫码登录
			</Btn>,
		);
		expect(btn().getAttribute("data-tour")).toBe("bili-login");
		expect(btn().getAttribute("data-bn")).toBe("btn btn-primary");
	});

	it("AddButton 同样透传", () => {
		render(<AddButton data-tour="adapter-add">＋ 新建适配器</AddButton>);
		expect(btn().getAttribute("data-tour")).toBe("adapter-add");
	});

	it("AddCard 同样透传", () => {
		render(<AddCard data-tour="subs-add" label="添加 UP 主" hint="UID / 名称搜索" />);
		expect(btn().getAttribute("data-tour")).toBe("subs-add");
	});

	it("data-tour 传 undefined 就不挂属性 —— 条件灯位(只标未测通的行)靠这条", () => {
		render(<Btn data-tour={undefined}>测试</Btn>);
		expect(btn().hasAttribute("data-tour")).toBe(false);
	});
});

/**
 * `Btn` 的 JSDoc 白纸黑字写着 `aria-*` 原样透传,但 `ariaHasPopup` / `ariaExpanded`
 * 两个别名 prop 是**写在 `{...rest}` 之后**的 —— 调用方按文档传原生名时会被
 * undefined 顶掉,而 React 对 undefined 干脆不出属性:下拉的展开态读屏整个拿不到,
 * 编译期还毫无征兆(2026-08-31 审查)。
 */
describe("原生 aria-* 透传", () => {
	it("原生 aria-expanded / aria-haspopup 不被同名别名 prop 顶掉", () => {
		render(
			<Btn aria-haspopup="menu" aria-expanded>
				切换
			</Btn>,
		);
		expect(btn().getAttribute("aria-expanded")).toBe("true");
		expect(btn().getAttribute("aria-haspopup")).toBe("menu");
	});

	it("别名 prop 仍是权威 —— 两边都给时以 ariaExpanded 为准", () => {
		render(
			<Btn ariaExpanded={false} aria-expanded>
				切换
			</Btn>,
		);
		expect(btn().getAttribute("aria-expanded")).toBe("false");
	});

	it("两边都不给就不挂属性", () => {
		render(<Btn>切换</Btn>);
		expect(btn().hasAttribute("aria-expanded")).toBe(false);
		expect(btn().hasAttribute("aria-haspopup")).toBe(false);
	});
});
