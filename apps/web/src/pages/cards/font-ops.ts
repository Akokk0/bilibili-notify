/**
 * 字体选择的纯操作。全部不可变,供 `FontPicker` 与单测复用。
 *
 * 数据模型是两个字段:`font`(家族名)与 `fontAsset`(主人上传的字体文件的资产 id)。
 * **`fontAsset` 设着就优先**,所以切档时它必须被显式清掉 —— 留着的话选择器显示的是
 * 手填那档、出图用的却还是上传那款,而两边都看不出哪里不对(本仓库反复复发的那类
 * 「切了没生效」)。
 */

/** 卡片样式里与字体有关的那两栏。只声明用得到的,不绑整个 CardStyle。 */
import { FONT_ASSET_WARN_BYTES } from "@bilibili-notify/internal/constants";

export interface FontChoice {
	font: string;
	fontAsset?: string;
}

/**
 * 选择器当前落在哪一档。
 *
 * **没有「内置字体」这一档。** 曾经摆过思源黑 / 思源宋两行 —— 那是 Docker 镜像装的
 * (`fonts-noto-cjk`,见 `apps/base.Dockerfile`),因为容器里本来一个中文字体都没有,
 * 不塞就渲染不出中文。可出图用的是**渲染那台机器**的字体:桌面版走的是主人自己的
 * Chrome,字体池是操作系统的,而 Windows / macOS 默认都没装 Noto CJK —— 那两行在
 * 桌面版就是哑弹,选了静静回落兜底链,界面上还写着「一定渲染得出来」。
 *
 * 两端唯一都成立的说法只有「默认」:交给渲染那台机器自己挑,容器里挑到的正是我们塞
 * 进去的 Noto,Windows / macOS 挑到的是它们自带的中文字体。要别的就上传字体文件
 * (两端都作数),或者走「手填」用本机装过的。
 */
export type FontSelection =
	| { kind: "default" }
	| { kind: "uploaded"; id: string }
	/** 选着一款已经不在图廊里的字体(文件被删 / 卷丢了)。 */
	| { kind: "missing"; id: string }
	| { kind: "custom"; family: string };

/**
 * 算出当前该高亮哪一档。
 *
 * `uploadedIds` 传 `null` = 图廊列表还没到 —— 此时**不判失效**,否则每次进页面都会
 * 先闪一下「已失效」。
 */
export function fontSelection(v: FontChoice, uploadedIds: string[] | null): FontSelection {
	if (v.fontAsset) {
		if (uploadedIds !== null && !uploadedIds.includes(v.fontAsset)) {
			// 悄悄回落成「默认」是不行的:主人明明选过一款,界面上却再没有任何入口
			// 告诉他那款没了,只会觉得「我选的字体怎么自己变回去了」。
			return { kind: "missing", id: v.fontAsset };
		}
		return { kind: "uploaded", id: v.fontAsset };
	}
	if (!v.font) return { kind: "default" };
	return { kind: "custom", family: v.font };
}

/** 切到「默认(系统兜底)」——两栏都清空。 */
export function pickDefaultFont(v: FontChoice): FontChoice {
	const { fontAsset: _drop, ...rest } = v;
	return { ...rest, font: "" };
}

/** 切到某个家族名(现在只有「手填」那一档走这里)——**必须清掉资产**,否则它继续说了算。 */
export function pickFamilyFont(v: FontChoice, family: string): FontChoice {
	const { fontAsset: _drop, ...rest } = v;
	return { ...rest, font: family };
}

/**
 * 切到主人上传的某一款。
 *
 * 家族名**留着不动**:哪天这个文件没了(删盘 / 卷丢),渲染会回落到它,总好过回落到
 * 一串谁也没选过的兜底链。
 */
export function pickUploadedFont(v: FontChoice, id: string): FontChoice {
	return { ...v, fontAsset: id };
}

/**
 * 某款字体删盘之后,把它从一份样式里剔除(没选它的样式原样返回)。
 *
 * 与背景图的 `removeAssetFromStyle` 同一件事:页面上还攥着这个 id 的其他样式草稿
 * (全局基准 / per-kind / per-UP)若不清扫,下次保存就落盘成悬空引用。
 */
export function removeFontFromStyle<T extends { fontAsset?: string }>(style: T, id: string): T {
	if (style.fontAsset !== id) return style;
	const { fontAsset: _drop, ...rest } = style;
	return rest as T;
}

/** 同上,作用于 per-kind 覆盖表:逐 kind 清扫,没选这款的原样保留。 */
export function removeFontFromByKind<T extends { fontAsset?: string }>(
	byKind: Record<string, T>,
	id: string,
): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [kind, style] of Object.entries(byKind)) out[kind] = removeFontFromStyle(style, id);
	return out;
}

/**
 * 传上来的这款字体够大到该提醒吗?返回提醒文案,不用提醒则返回 null。
 *
 * 上限(20MB)是按「文件本身多大」定的,**没算出图时的开销**:字体会被 base64 内联进
 * 渲染 HTML(再涨三分之一),而 Docker 镜像里 V8 的 old-space 上限只有 384MB。所以一款
 * 完全合法的 20MB ttf,照样能让卡片渲染不出来。
 *
 * 提醒而不是拒收:降上限会把主人已经传上去的那款挡在门外。
 */
export function fontSizeWarning(bytes: number): string | null {
	if (bytes <= FONT_ASSET_WARN_BYTES) return null;
	const mb = (bytes / 1024 / 1024).toFixed(1);
	return `这款字体有 ${mb} MB —— 出图时它会整份进内存，在 Docker（默认堆上限 384MB）里容易把服务撑爆。同一套字转成 woff2 通常只占三分之一，建议换 woff2 再传。`;
}
