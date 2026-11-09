// @vitest-environment jsdom

/**
 * 卡片外框那一节的**出血**控件(ADR-0014 决策 19 的 🔗)。
 *
 * 单独开一份而不是并进 `skin-draft-ops.test.ts`:那份钉的是「`setFrame` 收到 patch 之后
 * 怎么改清单」,它全绿也证明不了**面板上真有一个控件把 patch 发出来**。皮肤这一摊已经
 * 栽过一次同族的:`cardSkin` 这个可选参数从头到尾没人传,两端的单测各自全绿、类型也绿,
 * 只有主人开着面板才看出来。所以这里钉的是那条线本身。
 */

import { DEFAULT_CARD_SKIN } from "@bilibili-notify/internal";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { SkinInspector } from "../SkinInspector";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

afterEach(cleanup);

function mount(over: Record<string, unknown> = {}) {
	const onFrame = vi.fn();
	render(
		<SkinInspector
			manifest={structuredClone(DEFAULT_CARD_SKIN)}
			kind="live"
			selection={{ kind: "frame" }}
			onGrid={vi.fn()}
			onCss={vi.fn()}
			onHtml={vi.fn()}
			onShowIf={vi.fn()}
			onFrame={onFrame}
			onFrameCss={vi.fn()}
			onColumns={vi.fn()}
			{...over}
		/>,
	);
	return { onFrame };
}

describe("常用旋钮接在哪一层", () => {
	/** 外框那一节读的必须是 `[data-bn="frame"]`,块那一节读的必须是 `[data-bn="self"]`。 */
	function withCss(frameCss: string, selection: { kind: "frame" } | { kind: "block"; id: string }) {
		const m = structuredClone(DEFAULT_CARD_SKIN) as unknown as {
			cards: Record<string, Record<string, unknown>>;
		};
		m.cards.live = { ...m.cards.live, css: frameCss };
		const onFrameCss = vi.fn();
		render(
			<SkinInspector
				manifest={m as never}
				kind="live"
				selection={selection}
				onGrid={vi.fn()}
				onCss={vi.fn()}
				onHtml={vi.fn()}
				onShowIf={vi.fn()}
				onFrame={vi.fn()}
				onFrameCss={onFrameCss}
				onColumns={vi.fn()}
			/>,
		);
		return { onFrameCss };
	}

	it("外框那一节读的是 frame 那条规则 —— 传错挂点这条就红", () => {
		withCss('[data-bn="frame"]{padding:20px}', { kind: "frame" });
		expect((screen.getByLabelText("内边距") as HTMLInputElement).value).toBe("20");
	});

	it("外框那段 CSS 里写了什么规则就列什么,选择器照原文显示、不按挂点筛", () => {
		withCss('[data-bn="self"]{padding:20px}', { kind: "frame" });
		expect((screen.getByLabelText(/的选择器$/) as HTMLInputElement).value).toBe('[data-bn="self"]');
	});

	it("拧外框的旋钮 → 走 onFrameCss 交回整段", () => {
		const { onFrameCss } = withCss('[data-bn="frame"]{padding:20px}', { kind: "frame" });
		fireEvent.change(screen.getByLabelText("内边距"), { target: { value: "24" } });
		expect(onFrameCss).toHaveBeenCalledWith('[data-bn="frame"]{padding:24px}');
	});
});

describe("卡片外框 — 出血", () => {
	it.each([
		[
			"en",
			"Select a block in the canvas or choose Card frame at the bottom. Select the skin name in the header to edit its details.",
			"This skin does not define this card type.",
			"This card does not contain this block.",
		],
		[
			"ja",
			"キャンバスのブロックか、下部の「カードの外枠」を選んでください。スキン自体の情報を編集するには、ヘッダーのスキン名を選びます。",
			"このスキンにはこの種類のカードがありません。",
			"このカードにはこのブロックがありません。",
		],
		[
			"zh-TW",
			"請選取畫布中的區塊，或底部的「卡片外框」；若要編輯外觀資料，請點選頂欄的外觀名稱。",
			"此外觀未定義此類型的卡片。",
			"此卡片沒有這個區塊。",
		],
	] as const)(
		"%s empty inspector states explain the selection without issuing edits",
		(locale, empty, missingCard, missingBlock) => {
			i18n.set({ locale, voice: "plain" });
			const none = mount({ selection: null });
			expect(screen.getByText(empty)).toBeTruthy();
			expect(none.onFrame).not.toHaveBeenCalled();
			cleanup();
			const absent = mount({ manifest: { ...structuredClone(DEFAULT_CARD_SKIN), cards: {} } });
			expect(screen.getByText(missingCard)).toBeTruthy();
			expect(absent.onFrame).not.toHaveBeenCalled();
			cleanup();
			const block = mount({ selection: { kind: "block", id: "original-missing" } });
			expect(screen.getByText(missingBlock)).toBeTruthy();
			expect(block.onFrame).not.toHaveBeenCalled();
		},
	);
	it.each([
		[
			"en",
			"Card width",
			"Row gap",
			"Column gap",
			"Bleed",
			"Card frame",
			"Return to default skin",
			"Return this card type to the built-in default?",
			"Cancel",
		],
		[
			"ja",
			"カード幅",
			"行間",
			"列間",
			"塗り足し",
			"カードの外枠",
			"既定スキンに戻す",
			"この種類のカードを内蔵の既定スキンに戻しますか？",
			"キャンセル",
		],
		[
			"zh-TW",
			"卡片寬度",
			"列間距",
			"欄間距",
			"出血",
			"卡片外框",
			"恢復預設外觀",
			"將此類型卡片恢復為內建預設外觀？",
			"取消",
		],
	] as const)(
		"%s frame controls translate and preserve callback meanings and cancelled resets",
		(locale, width, row, column, bleed, frameLabel, reset, confirm, cancel) => {
			const onDropCard = vi.fn();
			const { onFrame } = mount({ onDropCard });
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(frameLabel)).toBeTruthy();
			expect(onFrame).not.toHaveBeenCalled();
			for (const [label, value, patch] of [
				[width, "640", { width: 640 }],
				[row, "8", { gapRow: 8 }],
				[column, "12", { gapColumn: 12 }],
				[bleed, "24", { bleedSize: 24 }],
			] as const) {
				fireEvent.change(screen.getByLabelText(`${label}(`, { exact: false }), {
					target: { value },
				});
				expect(onFrame).toHaveBeenLastCalledWith(patch);
			}
			fireEvent.click(screen.getByRole("button", { name: reset }));
			expect(screen.getByText(confirm)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: cancel }));
			expect(onDropCard).not.toHaveBeenCalled();
		},
	);
	it("有一个数字控件,改了它把 bleedSize 发出去", () => {
		const { onFrame } = mount();
		const input = screen.getByLabelText(/出血/);
		fireEvent.change(input, { target: { value: "24" } });
		expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ bleedSize: 24 }));
	});

	it("说得出它是干什么的 —— 光写「出血」两个字没人知道那是辉光的余量", () => {
		mount();
		expect(screen.getByText(/辉光/)).toBeTruthy();
	});
});

it.each([
	[
		"ja",
		"ご主人様、中央のキャンバスでブロックか、一番下の「カードの外枠」を選んでくださいね。スキン自体の名前を変えるときは、ヘッダーの名前を選びますよ。",
		"ご主人様、塗り足しはカードの外に光彩を描くための余白ですよ。画像はカードの外接矩形で切り取るので、レイアウトの幅や高さに含まれない影や光彩は、この余白がないと切れてしまいます。",
		"ご主人様、サイズを正確に合わせたいバッジには固定幅の列が使えますよ。12等分では、ぴったり収まらないことがあります。",
		"ご主人様、この種類のカードのブロック・配置・CSSを、このスキンからすべて取り除きます。描画は内蔵の既定スキンに戻りますよ。もう一度編集するには、改めてこのスキンで設定してくださいね。",
		"既定スキンに戻す",
		"キャンセル",
		"塗り足し",
	],
	[
		"zh-TW",
		"主人，請在中央畫布選一個區塊，或最下面的「卡片外框」喔；要改外觀本身的名稱，請點頂欄的名稱。",
		"主人，出血是留給卡片外圍光暈的空間喔。出圖會沿卡片的外接矩形裁切，陰影和光暈不占排版空間；沒留出血的話，超出外框的部分就會被裁掉。",
		"主人，要精確控制徽章尺寸，可以使用固定寬度的欄喔；12 等分不一定剛好放得下。",
		"主人，這類卡片的區塊、位置和 CSS 會整份從這套外觀移除，出圖時改用內建預設外觀喔。想再編輯，就得重新接管一次。",
		"恢復預設外觀",
		"取消",
		"出血",
	],
] as const)(
	"%s 女仆选择、出血与交还说明切语不修改草稿，取消不交还",
	(locale, empty, bleed, fixed, dropping, reset, cancel, bleedLabel) => {
		const none = mount({ selection: null });
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(empty)).toBeTruthy();
		expect(none.onFrame).not.toHaveBeenCalled();
		cleanup();
		const onDropCard = vi.fn();
		const manifest = structuredClone(DEFAULT_CARD_SKIN);
		delete manifest.cards.live?.columns;
		const { onFrame } = mount({ manifest, onDropCard });
		expect(screen.getByText(bleed)).toBeTruthy();
		expect(screen.getByText(fixed)).toBeTruthy();
		expect(onFrame).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText(`${bleedLabel}(`, { exact: false }), {
			target: { value: "24" },
		});
		expect(onFrame).toHaveBeenCalledTimes(1);
		expect(onFrame).toHaveBeenCalledWith({ bleedSize: 24 });
		fireEvent.click(screen.getByRole("button", { name: reset }));
		expect(screen.getByText(dropping)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: cancel }));
		expect(onDropCard).not.toHaveBeenCalled();
	},
);

it.each([
	[
		"ja",
		"ご主人様、このブロックの高さは行の占有数で決まりますよ。1行は56pxで、画像は縦横比を保ちながら領域いっぱいに切り抜かれます。",
		"ご主人様、このブロックは内容に合わせて高くなりますよ。行の占有数はキャンバス上の配置にだけ使います。実際の高さを変えたいときは、下のCSSで指定してくださいね。",
		"ご主人様、選んだフィールドが真の場合だけ、このブロックを描きますよ。この種類のカードで使えるフィールドだけが候補になり、ほかの種類のフィールドを指定したパッケージは取り込めません。",
		"ご主人様、このブロックは「original-title」と重なっていますよ。重なり順が大きい方が前面になり、同じならブロックの並び順で前後が決まります。",
		"ご主人様、このブロックには独自の内容（カスタムHTML・ブロックのCSS・アセット変数）があります。削除すると元に戻せませんよ。内蔵ブロックは「ブロックを追加」から置き直せますが、これらの内容は戻りません。",
		"ブロックを削除",
		"キャンセル",
	],
	[
		"zh-TW",
		"主人，跨列數就是這個區塊的高度喔，每列 56px，圖片會維持比例裁切並填滿空間。",
		"主人，這個區塊的高度由內容撐開，文字越多就越高喔；跨列數只影響畫布上占用的格數。要改實際高度，請在下方 CSS 指定。",
		"主人，所選欄位為真時才會繪製這個區塊喔。候選項目只列出此類型卡片支援的欄位；套件若使用其他類型的欄位，匯入時會遭拒。",
		"主人，這個區塊與 「original-title」 重疊了喔；堆疊順序較大者會顯示在上方，相同時則由區塊排列順序決定前後。",
		"主人，這個區塊帶有自己的內容（自訂 HTML、區塊 CSS 與素材變數），刪除後就找不回來了喔。內建區塊能從「新增區塊」重新放回，但這些內容無法還原。",
		"刪除此區塊",
		"取消",
	],
] as const)(
	"%s 女仆块高度、条件与重叠说明保留原块，取消删除不回调",
	(locale, imageHeight, contentHeight, condition, overlap, warning, remove, cancel) => {
		const manifest = structuredClone(DEFAULT_CARD_SKIN);
		const live = manifest.cards.live;
		if (!live) throw new Error("Default live card missing");
		live.blocks = [
			{
				id: "cover",
				kind: "builtin",
				builtin: "cover",
				css: "/* Original 原文 */",
				grid: { row: 1, column: 1, span: 12, rowSpan: 2 },
			},
			{
				id: "original-title",
				kind: "builtin",
				builtin: "title",
				grid: { row: 1, column: 1, span: 12 },
			},
		];
		const onRemove = vi.fn();
		const onGrid = vi.fn();
		mount({ manifest, selection: { kind: "block", id: "cover" }, onRemove, onGrid });
		act(() => i18n.set({ locale, voice: "maid" }));
		expect(screen.getByText(imageHeight)).toBeTruthy();
		expect(screen.getByText(condition)).toBeTruthy();
		expect(screen.getByText(overlap)).toBeTruthy();
		expect(onGrid).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: remove }));
		expect(screen.getByText(warning)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: cancel }));
		expect(onRemove).not.toHaveBeenCalled();
		cleanup();
		mount({ manifest, selection: { kind: "block", id: "original-title" }, onGrid });
		expect(screen.getByText(contentHeight)).toBeTruthy();
		expect(onGrid).not.toHaveBeenCalled();
		expect(manifest.cards.live?.blocks[0]?.css).toBe("/* Original 原文 */");
	},
);

it.each([
	[
		"ja",
		"ご主人様、この3項目はマニフェストの先頭に保存されますよ。スキンライブラリーの一覧や、書き出したパッケージにもこの情報を使います。",
		"ご主人様、ここで宣言した項目はカード設定の「スキンの調整」に並びますよ。変更値は --bn-knob-<key> として渡されるので、スキンのCSSから var(--bn-knob-<key>, fallback) で参照してくださいね。初期表示の値は渡しません。実際の既定値はCSSの代替値です。",
		"ご主人様、調整項目はまだありません。このスキンでは、カード設定から調整できる項目がありませんよ。",
		"ご主人様、画像とフォントはこのスキンのパッケージに保存し、書き出すZIPにも含めますよ。ブロックのCSSやHTMLから asset:<name> で参照できます。",
		"ご主人様、先に上でフォントファイル（woff2 / woff / ttf / otf）をアップロードすると、ここで選べるようになりますよ。",
		"ご主人様、調整項目はすでに16個あります。これ以上は追加できませんよ。",
		"ご主人様、フォントはすでに4個あります。これ以上は追加できませんよ。",
		"スキン名",
		"調整項目を追加",
		"フォントを追加",
	],
	[
		"zh-TW",
		"主人，這三項會寫在資訊清單的開頭，外觀資源庫的列表和匯出的套件都會使用喔。",
		"主人，這裡宣告的項目會顯示在卡片設定的「外觀調整」喔。修改值會以 --bn-knob-<key> 傳入，可在外觀 CSS 用 var(--bn-knob-<key>, fallback) 引用。起始顯示值不會傳入，真正的預設值是 CSS 裡的備援值。",
		"主人，還沒有調整項目喔，這套外觀在卡片設定裡沒有可調整的項目。",
		"主人，圖片和字型都放在這套外觀的套件裡，匯出的 ZIP 也會帶上它們喔。在區塊的 CSS 或 HTML 中，用 asset:<name> 就能引用。",
		"主人，先在上方上傳一份字型檔（woff2 / woff / ttf / otf），這裡才選得到喔。",
		"主人，已經有 16 個調整項目，不能再新增了喔。",
		"主人，已經有 4 款字型，不能再新增了喔。",
		"外觀名稱",
		"新增調整項目",
		"新增字型",
	],
] as const)(
	"%s 女仆元信息、资源与旋钮说明保留原名，满额不再添加",
	(locale, meta, knobs, empty, assets, upload, knobLimit, fontLimit, name, addKnob, addFont) => {
		const manifest = structuredClone(DEFAULT_CARD_SKIN);
		manifest.name = "Original skin 原文";
		manifest.knobs = [];
		manifest.fonts = [{ family: "Original Font 原文", asset: "asset:assets/original.woff2" }];
		const onMeta = vi.fn();
		const onAdd = vi.fn();
		const onAddFont = vi.fn();
		const onKnobs = {
			onAdd,
			onRemove: vi.fn(),
			onDecl: vi.fn(),
			onType: vi.fn(),
			onDefault: vi.fn(),
			onNumber: vi.fn(),
			onSwitch: vi.fn(),
			onOptionAdd: vi.fn(),
			onOption: vi.fn(),
			onOptionRemove: vi.fn(),
		};
		const onAssets = {
			onAddFont,
			onUpload: vi.fn(),
			onDeleteAsset: vi.fn(),
			onFont: vi.fn(),
			onRemoveFont: vi.fn(),
		};
		mount({
			manifest,
			selection: { kind: "skin" },
			onMeta,
			onKnobs,
			onAssets,
			assets: { names: [], pending: false },
		});
		act(() => i18n.set({ locale, voice: "maid" }));
		for (const hint of [meta, knobs, empty, assets, upload])
			expect(screen.getByText(hint)).toBeTruthy();
		expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe("Original skin 原文");
		expect(onMeta).not.toHaveBeenCalled();
		expect(onAdd).not.toHaveBeenCalled();
		expect(onAddFont).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText(name), { target: { value: "Original renamed 原文" } });
		expect(onMeta).toHaveBeenCalledTimes(1);
		expect(onMeta).toHaveBeenCalledWith({ name: "Original renamed 原文" });
		cleanup();
		manifest.knobs = Array.from({ length: 16 }, (_, i) => ({
			key: `original-${i}`,
			label: `Original ${i}`,
			type: "color" as const,
			default: "#ff00aa",
		}));
		manifest.fonts = Array.from({ length: 4 }, (_, i) => ({
			family: `Original Font ${i}`,
			asset: `asset:assets/original-${i}.woff2`,
		}));
		mount({
			manifest,
			selection: { kind: "skin" },
			onMeta,
			onKnobs,
			onAssets,
			assets: { names: [], pending: false },
		});
		expect(screen.getByText(knobLimit)).toBeTruthy();
		expect(screen.getByText(fontLimit)).toBeTruthy();
		expect(screen.queryByRole("button", { name: addKnob })).toBeNull();
		expect(screen.queryByRole("button", { name: addFont })).toBeNull();
		expect(onMeta).toHaveBeenCalledTimes(1);
		expect(onAdd).not.toHaveBeenCalled();
		expect(onAddFont).not.toHaveBeenCalled();
		expect(manifest.fonts[0]?.family).toBe("Original Font 0");
	},
);
