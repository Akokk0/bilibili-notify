// @vitest-environment jsdom

/**
 * AddButton / AddCard —— 「这里还能再加一个」的虚线控件。
 *
 * 收编前站内九处手写,圆角在 `rounded-md/lg/xl/bn-sm/bn-pill` **五种**之间漂,
 * 字号 10.5 / 12 / 12.5 / 13px 四种,字重 medium / semibold / bold 三种,hover
 * 更是五种写法 —— 而语义只有一个:虚线=「空位」,指上去变粉=「点我」。
 *
 * 拆成两个而不是一个带 `variant` 的:`AddCard` 连内部结构(＋ / 标题 / 副标题)
 * 一起给,`AddButton` 收自由 children,塞进同一个组件只会得到一个两幅面孔的壳。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ArrayEditor } from "../form-controls";
import { AddButton, AddCard, AddFileButton } from "../index";

afterEach(cleanup);

const btn = () => screen.getByRole("button");

/**
 * 两个组件共用的语汇:虚线中性边 + 指上去变粉,且**不挂皮肤挂点**。
 *
 * 边色是 `bn-inactive/50` 而非家族外通用的 `bn-border` —— 默认亮色下 #e5e7eb
 * 压在带粉调的卡底上几乎隐形(2026-08-30 主人真机指出)。只加浓这一家族,
 * EmptyNote 与共享 token 原样不动:皮肤对 note 挂点只写线型不写颜色,动了
 * 共享语汇会穿透到所有皮肤。
 */
function expectAddLanguage(el: HTMLElement) {
	const cls = el.className.split(/\s+/);
	// hover 三件套(粉描边 + 粉字 + 粉纱底)是整族统一的说法 —— 此前粉纱只有
	// AddCard 自己有,「+ 添加一行」hover 变白底、「添加 UP」chip 只加深文字,
	// 2026-08-30 主人对着四张截图点名统一。
	for (const c of [
		"border",
		"border-dashed",
		"border-bn-inactive/50",
		"hover:border-bn-pink",
		"hover:text-bn-pink",
		"hover:bg-bn-pink/5",
		"transition",
	]) {
		expect([c, cls.includes(c)]).toEqual([c, true]);
	}
	// 挂 `add-slot` 专词(2026-08-30 主人开口开的口子):皮肤能点名调虚线与淡底了。
	// btn 仍然禁挂 —— 皮肤的按钮实底会把空位画成真按钮(2026-08-23 定案未动)。
	expect((el.getAttribute("data-bn") ?? "").split(/\s+/).filter(Boolean)).toEqual(["add-slot"]);
}

describe("AddButton", () => {
	it("默认行内档:药丸圆角,跟同排的胶囊一个形状", () => {
		render(<AddButton onClick={() => {}}>＋ 添加推送目标</AddButton>);
		expectAddLanguage(btn());
		expect(btn().className).toContain("rounded-bn-pill");
		expect(btn().className).toContain("inline-flex");
	});

	it("block 档占满一整行,换成卡片圆角 —— 整行的药丸不像话", () => {
		render(
			<AddButton block onClick={() => {}}>
				＋ 添加分条符
			</AddButton>,
		);
		expectAddLanguage(btn());
		expect(btn().className).toContain("w-full");
		expect(btn().className).toContain("rounded-lg");
		expect(btn().className).not.toContain("rounded-bn-pill");
	});

	it("字色平时是 secondary,指上去才变粉", () => {
		render(<AddButton onClick={() => {}}>＋</AddButton>);
		expect(btn().className).toContain("text-bn-text-secondary");
		expect(btn().className).toContain("hover:text-bn-pink");
	});

	it("点得动,禁用时点不动", () => {
		const onClick = vi.fn();
		const { unmount } = render(<AddButton onClick={onClick}>＋</AddButton>);
		fireEvent.click(btn());
		expect(onClick).toHaveBeenCalledTimes(1);
		unmount();
		render(
			<AddButton disabled onClick={onClick}>
				＋
			</AddButton>,
		);
		fireEvent.click(btn());
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("AddCard", () => {
	it("＋ 与标题、副标题都由组件出 —— 调用方只给文字", () => {
		render(<AddCard label="添加 UP 主" hint="UID / 名称搜索" onClick={() => {}} />);
		expectAddLanguage(btn());
		expect(screen.getByText("＋")).toBeTruthy();
		expect(screen.getByText("添加 UP 主")).toBeTruthy();
		expect(screen.getByText("UID / 名称搜索")).toBeTruthy();
	});

	it("标题最重、副标题最轻 —— 三行的分量顺序不许倒", () => {
		render(<AddCard label="新建连接" hint="连接实例" onClick={() => {}} />);
		expect(screen.getByText("新建连接").className).toContain("text-bn-text-primary");
		expect(screen.getByText("连接实例").className).toContain("text-bn-text-tertiary");
		expect(screen.getByText("＋").className).toContain("text-bn-text-tertiary");
	});

	/** 它是网格里的一格,得跟着同行的卡片一起被拉高。 */
	it("撑满栅格给的高度", () => {
		render(<AddCard label="x" hint="y" onClick={() => {}} />);
		expect(btn().className).toContain("h-full");
	});

	// 底色刻意不在示例里:虚线家族统一「只有虚线框、不带底色」,底透下去才和
	// Subs「添加 UP 主」一个样(2026-08-30 主人定案,调用点的 bg-bn-surface 已随之拆掉)。
	it("className 只追加不冲突的(最小高度、焦点环),接在本体之后", () => {
		render(<AddCard label="x" hint="y" className="min-h-22" onClick={() => {}} />);
		expect(btn().className.endsWith("min-h-22")).toBe(true);
	});

	it("禁用时点不动", () => {
		const onClick = vi.fn();
		render(<AddCard label="x" hint="y" disabled onClick={onClick} />);
		fireEvent.click(btn());
		expect(onClick).not.toHaveBeenCalled();
	});
});

/**
 * **jsdom 里装不出「挑同一份文件第二次」这件事**,所以这里自己把浏览器那条规矩摆出来。
 *
 * 两处都指望不上:RTL 的 `fireEvent` 用 `defineProperty` 把 `files` 盖在元素上,而原生的
 * `value` getter 读的是 jsdom 内部那份文件表 —— 于是不管组件重没重置 `value`,测出来的
 * `input.value` 恒是空串、`fireEvent.change` 也照发不误。不装这一层的话,这条用例在修之前
 * 就是绿的(「测试绿了,但不是因为你测的那件事」)。
 *
 * 装上之后 `value` 就是浏览器里那三条规矩:①「现在挑着哪份文件」;② 只准被设成空串
 * (同 HTML 规范),而且**清了 `files` 跟着空**;③ 挑文件时**值没变就不发 change** ——
 * 那正是「同一份文件传不了第二次」的成因。②也是一条真闸:先清再读,读到的就是空。
 */
function browserFilePicker(input: HTMLInputElement): (file: File) => void {
	let picked = "";
	const setFiles = (files: File[]) => {
		Object.defineProperty(input, "files", { configurable: true, writable: true, value: files });
	};
	Object.defineProperty(input, "value", {
		configurable: true,
		get: () => picked,
		set: (next: string) => {
			if (next !== "") throw new Error("file input 的 value 只能被设成空串");
			picked = "";
			setFiles([]);
		},
	});
	return (file) => {
		// 值没变(同一份文件,上一次挑完没人清)—— 浏览器什么都不做。
		if (picked === file.name) return;
		picked = file.name;
		setFiles([file]);
		fireEvent.change(input, {});
	};
}

describe("AddFileButton", () => {
	it("同一份文件挑两次都报得上来 —— 传完把 input 的 value 清掉", () => {
		const onFile = vi.fn();
		render(
			<AddFileButton accept=".zip" onFile={onFile}>
				传一个包
			</AddFileButton>,
		);
		const pick = browserFilePicker(screen.getByLabelText("传一个包") as HTMLInputElement);
		const same = new File(["x"], "same.zip");

		pick(same);
		pick(same);

		// 「删了再传回来」是真实路径:传上去被拒(重名 / 太大)之后原样再传一次也是。
		expect(onFile).toHaveBeenCalledTimes(2);
		expect(onFile).toHaveBeenNthCalledWith(2, same);
	});

	it("先把文件取出来再清 value —— 反过来的话清空会连 `files` 一起带走", () => {
		const onFile = vi.fn();
		render(
			<AddFileButton accept=".zip" onFile={onFile}>
				传一个包
			</AddFileButton>,
		);
		const pick = browserFilePicker(screen.getByLabelText("传一个包") as HTMLInputElement);
		const file = new File(["x"], "a.zip");

		pick(file);

		expect(onFile).toHaveBeenCalledWith(file);
	});
});

describe("家族其余成员共用同一句话", () => {
	it("表单「+ 添加一行」也说 ADD_LANGUAGE —— 不再自带白底、hover 不再变白", () => {
		render(<ArrayEditor value={[]} onChange={() => {}} />);
		const row = screen.getByText(/添加一行/);
		expectAddLanguage(row);
		expect(row.className).not.toContain("bg-bn-field");
		expect(row.className).not.toContain("hover:bg-bn-surface");
	});
});
