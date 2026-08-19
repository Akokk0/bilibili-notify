// @vitest-environment jsdom
/**
 * 输入框的**附件**交互 —— 挑图、去图、上限、以及「只发图不打字」。
 *
 * 最后一条最容易被漏掉:主人拖一张图进来、直接回车,如果发送键是灰的,那看着
 * 就是功能坏了 —— 而「这是什么」这句话本来就是多余的,图本身就是问题。
 *
 * Composer 是**纯展示**的:上传发生在它外面,它只拿到已经传好的 `{id,url}`。
 * 这样它不必碰 fetch,也不必知道资产路由长什么样。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Composer } from "../composer";

afterEach(cleanup);

type Attachment = { id: string; url: string };

function renderComposer(over: Partial<Parameters<typeof Composer>[0]> = {}) {
	const onSubmit = vi.fn();
	const onRemoveAttachment = vi.fn();
	const onPickFiles = vi.fn();
	render(
		<Composer
			value=""
			onChange={() => {}}
			onSubmit={onSubmit}
			busy={false}
			aiName="小绫"
			attachments={[]}
			onPickFiles={onPickFiles}
			onRemoveAttachment={onRemoveAttachment}
			{...over}
		/>,
	);
	return { onSubmit, onRemoveAttachment, onPickFiles };
}

const one: Attachment = { id: `${"a".repeat(32)}.png`, url: "/api/ai/assets/a.png" };
const two: Attachment = { id: `${"b".repeat(32)}.png`, url: "/api/ai/assets/b.png" };

describe("Composer — 粘贴图片", () => {
	const composer = () => screen.getByLabelText("聊天输入");
	/** jsdom 不造 ClipboardEvent 的 clipboardData,自己拼一个够用的。 */
	const pasteWith = (items: Array<{ kind: string; type: string; file?: File }>) => {
		const ev = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(ev, "clipboardData", {
			value: { items: items.map((i) => ({ ...i, getAsFile: () => i.file ?? null })) },
		});
		return ev;
	};
	const png = () => new File([new Uint8Array([1, 2])], "x.png", { type: "image/png" });

	it("Ctrl+V 一张图 → 和点「+」挑图走同一条路", () => {
		// 截个图直接粘上来是最顺手的动作;逼主人先存盘再点「+」去找那个文件,
		// 是把一步拆成三步。
		const { onPickFiles } = renderComposer();
		const file = png();
		fireEvent(composer(), pasteWith([{ kind: "file", type: "image/png", file }]));
		expect(onPickFiles).toHaveBeenCalledTimes(1);
		expect(onPickFiles.mock.calls[0]?.[0]).toEqual([file]);
	});

	it("粘的是文字 → 照常粘进输入框,不当附件也不拦默认行为", () => {
		const { onPickFiles } = renderComposer();
		const ev = pasteWith([{ kind: "string", type: "text/plain" }]);
		fireEvent(composer(), ev);
		expect(onPickFiles).not.toHaveBeenCalled();
		expect(ev.defaultPrevented).toBe(false);
	});

	it("图文混着粘 → 只收图,但文字照旧粘进去", () => {
		// 从网页上复制一段带图的内容就是这个形状。吞掉文字等于让主人白复制一次。
		const { onPickFiles } = renderComposer();
		const file = png();
		const ev = pasteWith([
			{ kind: "string", type: "text/plain" },
			{ kind: "file", type: "image/png", file },
		]);
		fireEvent(composer(), ev);
		expect(onPickFiles.mock.calls[0]?.[0]).toEqual([file]);
		expect(ev.defaultPrevented).toBe(false);
	});

	it("粘的是 PDF 之类 → 不当图片收", () => {
		const { onPickFiles } = renderComposer();
		const pdf = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
		fireEvent(composer(), pasteWith([{ kind: "file", type: "application/pdf", file: pdf }]));
		expect(onPickFiles).not.toHaveBeenCalled();
	});
});

describe("Composer — 附件缩略图", () => {
	it("每张附件渲染一个缩略图", () => {
		renderComposer({ attachments: [one, two] });
		const imgs = screen.getAllByRole("img");
		expect(imgs).toHaveLength(2);
		expect(imgs[0].getAttribute("src")).toBe(one.url);
	});

	it("没有附件时不占位置", () => {
		renderComposer({ attachments: [] });
		expect(screen.queryAllByRole("img")).toHaveLength(0);
	});

	it("点叉把那一张的 id 交回去 —— 而不是下标", () => {
		// 交下标的话,连点两次「移除第 2 张」会因为数组已经变短而删错人。
		const { onRemoveAttachment } = renderComposer({ attachments: [one, two] });
		fireEvent.click(screen.getAllByRole("button", { name: /移除图片/ })[1]);
		expect(onRemoveAttachment).toHaveBeenCalledWith(two.id);
	});
});

describe("Composer — 上限", () => {
	// 「添加图片」现在是「+」二级菜单里的一项,得先展开菜单才摸得到它。
	const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "添加" }));

	it("到 4 张就不让再挑了", () => {
		const full = [one, two, { ...one, id: "c" }, { ...one, id: "d" }];
		renderComposer({ attachments: full });
		openMenu();
		expect((screen.getByRole("menuitem", { name: "添加图片" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("没满时挑图键是活的", () => {
		renderComposer({ attachments: [one] });
		openMenu();
		expect((screen.getByRole("menuitem", { name: "添加图片" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
	});
});

describe("Composer — 能不能发", () => {
	it("只有图、一个字没打也能发 —— 图本身就是问题", () => {
		const { onSubmit } = renderComposer({ value: "", attachments: [one] });
		fireEvent.click(screen.getByLabelText("发送"));
		expect(onSubmit).toHaveBeenCalled();
	});

	it("既没字也没图 → 发不出去", () => {
		const { onSubmit } = renderComposer({ value: "   ", attachments: [] });
		fireEvent.click(screen.getByLabelText("发送"));
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("等回复期间不许再发", () => {
		const { onSubmit } = renderComposer({ value: "在吗", attachments: [one], busy: true });
		fireEvent.click(screen.getByLabelText("发送"));
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
