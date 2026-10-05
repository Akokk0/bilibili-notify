/**
 * 批准的像素差清单(ADR-0028 决策 2,守卫 10)。形状与判官在 `card-diff-check.ts`。
 *
 * - `baseline`:清单开张(1.0 第 2 期 ⑩,2026-10-02)时 23 个样例的出图 hash。新加的夹具在这里补一行。
 * - `approvals`:之后每一次出图变化,**只往末尾追加**,一条写清样例、变化、类别、依据和新 hash。
 *   同一样例认最后一条;旧条目不改不删,它们就是出图变迁的账。
 */

import type { CardDiffList } from "./card-diff-check";

/**
 * ㉑c 第 1 步(2026-10-05):B 站作品卡不再画头像。九个走 B 站原始数据的 `dynamic-*` 样例同一次批准,
 * 清单按样例认账,所以下面九行共用这一段说明、各带各的 hash。
 *
 * 类别写 `master-approved`:三类预批(叫法中立化 / 内联 SVG 残差 / B 站纯装饰)都不贴切 —— 头像不是装饰,
 * 是 `Creator` 里实打实的一格,只是它在中立形状里只收图库引用、B 站的头像是远端地址,3a 才交引用
 * (ADR-0021 决策 22 下 2026-10-05 的 🔗,主人当天拍板「B 站作品卡到 3a 之前不画头像」)。
 *
 * 字节上只少了三样,别的一个字没动:头像格(外层与转发框里的内层各一份)、`.bn-blk-avatar` 那段块 CSS、
 * 以及只有头像那张 `<img>` 在用的 UnoCSS 工具类(`.shrink-0`;充电专属与「暂时无法渲染」两张卡连
 * `.object-cover` 也跟着没了)。名字 / 时间格的行列没变 —— 头像本来占的第 1 列就此空着(皮肤版式的事,
 * 留给 ㉔)。`dynamic-custom-layout` 的自定义版式里没摆头像块,字节不变,不在此列。拓展作品那条路自己造 node、
 * 照旧带头像,不受影响。
 */
const B_SITE_AVATAR_DROPPED = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	change:
		"B 站作品卡不再画头像:头像格整块收起(转发框里的内层同样),块 CSS 与只有头像在用的工具类随之消失",
	basis:
		"ADR-0021 决策 22 的 2026-10-05 🔗(㉑ 开片拷问):Creator.avatar 只收图库引用,B 站 3a 才交引用,到那时不画头像",
} as const;

/**
 * ㉑c 第 2 步(2026-10-05):B 站作品卡不画 `Post` 装不下的小图标与表情图。分两组,每组各带自己的依据,
 * 每个样例的 `change` 自己写(五个样例变的东西各不相同)。
 *
 * **第一组 · `master-approved`**:到 3a 才会以图库图回来的 —— 正文里 BV / AV 号与抽奖链接前的小图标
 * (`RichText` 的 `link.icon`)、预约卡抽奖行前的图标(`Attachment.card` 的 `lines[].icon`)、表情图(`emoji.image`)。
 * 它们在中立形状里只收图库引用,B 站的要到 3a 才存进图库。三类预批都不贴切:`library-image-residue` 说的是
 * 「内联 SVG 换成图库图之后的残差」,而这里还没换、只是先不画 —— 换回来那一步才会有残差。表情不是装饰,是正文的
 * 一部分,先按定案「没图时当文字显示」画它的 `text`。
 *
 * **第二组 · `bili-decoration-removed`**:形状里压根没有位置、也不会回来的 —— 预约按钮上的铃铛
 * (`button` 只有 `text` / `enabled`)、商品卡标题前的购物袋(`goods.eyebrow` 是纯文字)。两个都是 B 站纯装饰。
 * 预约按钮那个铃铛是条件渲染(`!isEnded && …`),不画之后已结束的预约卡少一个 Vue 的 `<!---->` 占位注释。
 *
 * 两组的字节变化都只有「图标 / 表情那几样」本身,外加只有它们在用的 UnoCSS 工具类(表情 `<img>` 带的
 * `.inline` / `.w-[17px]` / `.h-[17px]` / `.align-middle`)。外面那层 `flex items-center gap-1` 的壳先留着,
 * 不动 —— 去图标之外的字节不碰,版式上的收拾留给 ㉔。依据同第 1 步:ADR-0021 决策 22 的 2026-10-05 🔗
 * 「B 站卡的字节,形状逼着变的就变」。
 */
const B_SITE_ICONS_PENDING_LIBRARY = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	basis:
		"ADR-0021 决策 22 的 2026-10-05 🔗(㉑ 开片拷问):link.icon / lines[].icon / emoji.image 只收图库引用,B 站 3a 才交引用,到那时不画图标、表情当文字",
} as const;

const B_SITE_DECORATION_NO_SLOT = {
	category: "bili-decoration-removed",
	basis:
		"data-model「出图字节门」第三条(B 站纯装饰去掉)+ ADR-0021 决策 22 的 2026-10-05 🔗:Attachment 的 button / goods.eyebrow 里没有这个图标的位置",
} as const;

export const APPROVED_CARD_DIFFS: CardDiffList = {
	baseline: {
		"dynamic-article": "5dc8efb7725183cd",
		"dynamic-av": "3fe2f49baa0aa630",
		"dynamic-charge-only": "3bb0aea26e823e4e",
		"dynamic-custom-layout": "9c6b31abc3668adb",
		"dynamic-draw": "d8bd91abf31eafad",
		"dynamic-draw-single": "2b71a06c8da42d0f",
		"dynamic-forward": "e9349768a41a0b63",
		"dynamic-unrenderable": "c1c4a811f19545a4",
		"dynamic-with-additional": "47ca0a2ce1b3affe",
		"dynamic-word": "1619094b9d17a1a5",
		"guard-badge-left": "4953c32520c4813f",
		"guard-captain": "9f376b5f5cc8b981",
		"guard-governor": "1a670a2d04ad14ce",
		"live-ended": "cb3cbdd6abffbde9",
		"live-minimal": "821353aa66a17c4d",
		"live-streaming": "0198f11ccd8c998e",
		"live-with-fontface": "d90b9bbf14f30c22",
		"roast-board": "f9cd965bda97fc57",
		"roast-solo": "687842993460e699",
		"sc-custom-layout": "64f3c3cfef80c2a1",
		"sc-high": "c6f9e1a451794ab7",
		"sc-low": "6a6641a7c480ee7b",
		wordcloud: "a1444fb7ddc6f1ef",
	},
	approvals: [
		{ sample: "dynamic-article", ...B_SITE_AVATAR_DROPPED, hash: "8b65ad0bc7318a34" },
		{ sample: "dynamic-av", ...B_SITE_AVATAR_DROPPED, hash: "7cde7db446c7b712" },
		{ sample: "dynamic-charge-only", ...B_SITE_AVATAR_DROPPED, hash: "f0c6cd7ddbb59ae1" },
		{ sample: "dynamic-draw", ...B_SITE_AVATAR_DROPPED, hash: "6fb6f72b370824be" },
		{ sample: "dynamic-draw-single", ...B_SITE_AVATAR_DROPPED, hash: "a66ab7ec0deee7eb" },
		{ sample: "dynamic-forward", ...B_SITE_AVATAR_DROPPED, hash: "6bd80a6f1d5c9b80" },
		{ sample: "dynamic-unrenderable", ...B_SITE_AVATAR_DROPPED, hash: "c08e2e08fe2fe9c9" },
		{ sample: "dynamic-with-additional", ...B_SITE_AVATAR_DROPPED, hash: "cd1545569872a985" },
		{ sample: "dynamic-word", ...B_SITE_AVATAR_DROPPED, hash: "e07bf2a294fde0ea" },
		// ㉑c 第 2 步:小图标与表情图。
		{
			sample: "dynamic-word",
			...B_SITE_ICONS_PENDING_LIBRARY,
			change:
				"BV 号链接前的视频图标、抽奖链接前的图标不画(链接文字与颜色照旧);表情「[doge]」由图变成文字;表情 <img> 独占的四条工具类随之消失",
			hash: "172b1d322fd9c83a",
		},
		{
			sample: "dynamic-with-additional",
			...B_SITE_ICONS_PENDING_LIBRARY,
			change:
				"预约卡抽奖行前的图标不画(文字与粉色照旧);预约按钮上的铃铛不画(铃铛属第二组 bili-decoration-removed:按钮形状里没有它的位置)",
			hash: "e650729e78006930",
		},
		{
			sample: "dynamic-draw",
			...B_SITE_DECORATION_NO_SLOT,
			change: "商品卡标题(head_text)前的购物袋图标不画,文字照旧",
			hash: "c7b600f4c294bc75",
		},
		{
			sample: "dynamic-draw-single",
			...B_SITE_DECORATION_NO_SLOT,
			change: "商品卡标题(head_text)前的购物袋图标不画,文字照旧",
			hash: "0c35fcce0c92178e",
		},
		{
			sample: "dynamic-forward",
			...B_SITE_DECORATION_NO_SLOT,
			change:
				"已结束的预约卡:预约按钮上「未结束才画」的铃铛不画了,少一个 Vue 的 <!----> 占位注释(7 字节)",
			hash: "d61e5eb90eddcfa6",
		},
		// ㉑c 第 3 步:数字先成数字、再由 internal 统一排版。九份 dynamic-* 里数字原样回得去的(「16:07」「1.8万」
		// 「129」)字节不变;会变的只有排版逼的两类 —— 时长的前导零消失、接口给整数「万」时补小数位。夹具里
		// 只有一处命中:引用视频(UGC 附加卡)的时长「00:29」排成「0:29」。「1万」→「1.0万」的那一类夹具里没有,
		// 由 `dynamic-content-numbers.test.ts` 单测钉着。
		{
			sample: "dynamic-custom-layout",
			category: "master-approved",
			approvedOn: "2026-10-05",
			change:
				"引用视频(UGC 附加卡)的时长「00:29」先解析成 29 秒、再由 formatClock 排成「0:29」(前导零消失,别的一个字没动)",
			basis:
				"ADR-0021 决策 22 的 2026-10-05 🔗:播放数与时长先解析成数字、再由核心统一排版;决策 24:计数全程是数字,只在出口由 formatCount / formatClock 排一次版",
			hash: "cdced4d16d3f40de",
		},
	],
};
