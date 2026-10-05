/** @jsxImportSource vue */

/**
 * 一条动态的「呈现态」:节点类型({@link DynamicNode})与几个部件构建器(图廊、纯文本正文)。
 *
 * 节点由 `post-node.tsx` 的 `nodeFromPost` 从中立的 `Post` 造出来;拓展作品那条路(到 ㉑d 才切过来)
 * 自己造节点,吃同一套块。出卡器不认识任何平台的原始数据。
 *
 * 这里画出来的东西最终落在卡片皮肤的块里(ADR-0014 决策 9),所以部件上挂着那些块的
 * 挂点(`data-bn="<挂点>"`,名字取自 `CARD_SKIN_BUILTIN_BLOCKS.dynamic`):
 * - `node.text` / `node.media` 是同一份正文**拆开的两半**(决策 8 的 2026-09-18 🔗),分别进
 *   `text` / `media` 原子块:文字那半带着 `body` 挂点(挂在 `rich-text.tsx` 的根 div 上),
 *   媒体那半是主视频卡(`video` / `videoCover` / `videoTitle`)或图廊(`pics` / `pic`)。
 * - `node.additional` 进 `additional` 块 —— 四种附加卡的外壳(`card`)、封面(`cover`)与
 *   按钮(`button`)。`cover` 一律挂在**封面 img** 上(与 `videoCover` 同口径),不挂外面那层定
 *   宽框:框是版式,图才是「封面」。
 *
 * 挂点集合由 `__tests__/card-hooks.test.ts` 两头钉着:块里出现的挂点必须都在目录里,目录里
 * 声明的挂点也必须真被挂上。
 *
 * **这里暴露的 CSS 变量**(ADR-0014 决策 13 的 🔗,与 `blocks/dynamic.tsx` 同一张表):颜色的
 * **值**留在 inline 的 `--bn-*` 自定义属性里,颜色**属性**写到 class 上 —— 皮肤 CSS 的
 * `!important` 被清洗器摘掉,inline 声明永远压不过,写成 class 皮肤才染得动。
 *
 * | 变量 | 含义 | 挂在哪 |
 * | --- | --- | --- |
 * | `--bn-accent` | 强调色(充电专属块是 B 站粉,正文里的话题行是 B 站蓝) | 充电专属占位的标题 |
 * | `--bn-ink-faint` | 最弱的文字色 | 充电专属占位的说明行 |
 * | `--bn-inset-bg` | 淡底内嵌块的背景 | 主视频卡的外壳 |
 *
 * 写法用 UnoCSS 的**任意属性** `[color:var(--bn-x)]`,不用 `text-[var(--bn-x)]`:preset-wind4 的
 * 颜色工具类会编成 `color-mix(in oklab, … , transparent)`,那趟色彩空间往返**会动像素**
 * (本机 Chrome 实测,14 个颜色里 12 个栅格字节变了),像素门当场红。
 */

import type { RichText } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { renderRichText } from "../rich-text";

/**
 * 一条动态的「呈现态」结构树 —— 与任何平台的原始数据解耦,供 DynamicCard 按版式块装配。
 * 转发动态的内部原动态是 `forward`(同样是 DynamicNode),由卡片模版用**同一套版式**
 * 递归渲染。`body` 只含正文 + 主媒体(无附加内容、无转发框);`additional` 是拆出来的
 * 附加内容块(预约 / 商品 / 通用卡);`stats` 仅外层有(内部转发不展示互动数)。
 *
 * `text` 与 `media` 是正文的两半,各进一个原子块。从前还有第三份 `body`(两半粘在一起,
 * 喂 `content` 复合块)—— 复合块退役之后它只写不读,已经删掉(决策 8 的 2026-09-18 🔗)。
 * 两份仍**各是各的 VNode 实例**:Vue 文档明说一棵组件树里的 vnode 必须各不相同(客户端
 * 挂载会往 vnode 上写 `el` / `component`,后一处盖掉前一处),而皮肤可以把同一块摆两回。
 */
/**
 * 投稿视频那张卡的数据。播放 / 弹幕 / 时长已是排好版的字:`Post` 里它们是数字,由 `formatCount` /
 * `formatClock` 统一排版(见 `post-node.tsx` 的 `videoOf`);拓展那条路本来就是数字,同样经这两个函数。
 *
 * 播放数与弹幕数都**选填**(ADR-0019 决策 55):拓展的作品不收弹幕数、播放数是选填的,缺了哪一格
 * 就不画哪一格的图标与数字(从前只要有视频就无条件画,拓展作品会画出空图标)。B 站两格恒有。
 */
export type DynamicVideo = {
	cover: string;
	duration: string;
	title: string;
	desc: string;
	views?: string;
	danmaku?: string;
};

/**
 * 图廊里的一张图 —— **中立的形状**(ADR-0019 决策 68)。`Post` 的图与拓展的图都先映射成它,再交给
 * {@link buildGallery};图廊只有那一份实现。
 *
 * - 宽高缺了就不判长图,按普通比例铺(拓展的图宽高由 BN 读文件头拿,读不出来也照样出卡)。
 * - `animated` 由来源自己判:B 站看 `live_url` 或 `.gif` 结尾(`postFromDynamic` 里判,落成 `PostImage.isAnimated`),拓展看交来的 MIME ——
 *   拓展的图是 data URL,「看结尾」那一招对它不成立。
 */
export type GalleryImage = {
	url: string;
	width?: number;
	height?: number;
	animated?: boolean;
};

export type DynamicNode = {
	/**
	 * 头像地址。**选填,没有就不画头像**(头像块整块收起,皮肤契约的 `up.face` 是空串)。
	 *
	 * `Post` 这条路不给:`Creator.avatar` 只收图库引用,出卡器要到 ㉑d(拓展)/ 3a(B 站)才会按引用取图
	 * (ADR-0021 决策 22 的 2026-10-05 🔗)。拓展作品那条路(`extension-post-work.ts`)自己造 node,照旧给。
	 */
	avatarUrl?: string;
	upName: string;
	upIsVip: boolean;
	pubTime: string;
	/**
	 * 动态类型(`DYNAMIC_TYPE_*`),皮肤契约的 `dynamic.type`。造 node 时顺手记下(决策 68)——
	 * `Post` 这条路由 `nodeFromPost` 从作品的形状推;拓展作品套进 B 站的类型(决策 69)。不给就是空串。
	 */
	type?: string;
	/** 作为内部转发渲染时,附在作者名后的类型标签(如「投稿了视频」)。 */
	headerLabel?: string;
	topic?: string;
	/**
	 * 正文文字,进 `text` 原子块:正文的富文本(专栏连标题),充电专属是那块占位,`notice` 是那句提示。
	 * 一个字都没有(只发了图)时为空。
	 */
	text?: VNode | null;
	/**
	 * 投稿视频那张卡的**数据**,不是画好的 VNode —— 视频卡拆成了五块(封面 / 时长 / 标题 /
	 * 简介 / 播放·弹幕数),每块自己取自己那一份(决策 8 的 2026-09-18 🔗)。不是投稿视频
	 * 就为空;转发的原视频在 `forward.video` 里,不往外层提。
	 */
	video?: DynamicVideo | null;
	/**
	 * 图廊(图文 / 专栏)的图,**数据**不是画好的 VNode:`pics` 块拿它现画(`buildGallery`),
	 * 皮肤契约的张数 / 首图(`pics.count` / `pics.first`)也从这一份取 —— 画的和说的同一个
	 * 来源,不会一边有图一边说没有。没有图就不给(或给空数组)。
	 */
	images?: readonly GalleryImage[];
	additional?: VNode | null;
	forward?: DynamicNode;
	/**
	 * 互动数,已排好版的文本。某一项是空串 = 没有这一项,那一格连图标一起不画(拓展的作品三样各自
	 * 选填,决策 55);B 站三样恒有。
	 */
	stats?: { forward: string; comment: string; like: string };
};

/**
 * **纯文本正文** → `text` 块的那一份(ADR-0019 决策 68,给拓展作品用)。保留换行;标签原样
 * 当文字(转义)。
 *
 * 走的是 `Post` 富文本**同一个根**(`body` 挂点、同一套 class、同样超 9 行截断):切成富文本片段交给
 * {@link renderRichText},皮肤给正文写的规则两边一套,不必为拓展另写一份。
 *
 * `topics` 是来源报的话题名(决策 55 的 09-24 🔗):正文里的 `#名字#` / `#名字` 切成富文本
 * **同一种话题片段**,画出来是同一种 span。只照这份名单找 —— 不在名单里的 `#`(「C#」「#1」)
 * 一律当文字,BN 不按 `#` 自己猜。
 *
 * 一个字都没有(空串 / 只有空白)回 null,正文块收起。
 */
export function buildPlainText(text: string, topics: readonly string[] = []): VNode | null {
	const normalized = text.replace(/\r\n?/g, "\n");
	if (normalized.trim() === "") return null;
	return renderRichText(plainTextSegments(normalized, topics));
}

/** 字母或数字(任何文字的)—— `#名字` 后面紧跟着它,就不是这个话题。 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * 纯文本按话题名切成富文本节点:话题一段是话题节点,其余是文字节点。只在 `#` 所在的位置上试。
 *
 * - `#名字` 后面紧跟的不能是字母或数字:报了「cat」,`#category` 里不抠出一个 `#cat`;报了「旅行」,
 *   `#旅行今天` 也不算(与话题平台自己切话题的办法一致)。`#名字#` 自己带着边界,后面跟什么都行。
 * - 同一处能对上几种写法时:名字长的先(「旅行日记」与「旅行」都报了,`#旅行日记` 整个是话题),同一个
 *   名字 `#名字#` 先于 `#名字`(收尾的 `#` 算进话题)—— **除非**收尾的那个 `#` 正是下一个话题 `#别的`
 *   的开头(`#旅行#美食`,两个都报了):那就取 `#名字`,把 `#` 让给下一个,两个都上色。
 */
function plainTextSegments(text: string, topics: readonly string[]): RichText {
	const names = [...new Set(topics)]
		.filter((name) => name !== "")
		.sort((a, b) => b.length - a.length);
	/** 从 `at` 起是不是 `#名字`、而且后面没被字接着。 */
	const openAt = (at: number, name: string): boolean => {
		if (!text.startsWith(`#${name}`, at)) return false;
		const next = text.codePointAt(at + name.length + 1);
		return next === undefined || !WORD_CHAR.test(String.fromCodePoint(next));
	};
	const hitAt = (at: number): string | undefined => {
		for (const name of names) {
			if (text.startsWith(`#${name}#`, at)) {
				const closing = at + name.length + 1;
				return names.some((other) => openAt(closing, other)) ? `#${name}` : `#${name}#`;
			}
			if (openAt(at, name)) return `#${name}`;
		}
		return undefined;
	};
	const nodes: RichText = [];
	const pushText = (part: string) => {
		if (part) nodes.push({ kind: "text", text: part });
	};
	const pushTopic = (part: string) => {
		nodes.push({ kind: "topic", text: part, name: part.replace(/^#|#$/g, "") });
	};
	let plainFrom = 0;
	let at = names.length > 0 ? text.indexOf("#") : -1;
	while (at !== -1) {
		const hit = hitAt(at);
		if (hit) {
			pushText(text.slice(plainFrom, at));
			pushTopic(hit);
			plainFrom = at + hit.length;
			at = text.indexOf("#", plainFrom);
		} else {
			at = text.indexOf("#", at + 1);
		}
	}
	pushText(text.slice(plainFrom));
	return nodes;
}

/** 图廊最多铺几格 —— 与 B 站网页端一致,余下的折进最后一格的 `+N`。 */
const MAX_GRID_PICS = 9;

/** 高是不是超过宽的 `ratio` 倍。宽高缺一样就不算(不知道就当普通比例)。 */
function tallerThan(p: GalleryImage, ratio: number): boolean {
	return p.width !== undefined && p.height !== undefined && p.height > p.width * ratio;
}

/**
 * 右下角那个小角标的文案,都不满足则不出。
 *
 * 动图压过长图:「这张会动」是截图里绝对看不出来的信息(出图只截得到一帧),而「被裁
 * 过」在缩略图上多少感觉得到。两者同时成立极罕见,不值得为它另设一个双标签位。
 */
function picBadgeText(p: GalleryImage, isLong: boolean): string | null {
	if (p.animated) return "动图";
	return isLong ? "长图" : null;
}

/**
 * **图廊**(`pics` 块画的那一整块):一份中立的图列表 → 单图 / 长图 / 超长图 / 九宫格,
 * 最多铺 9 格,其余折进最后一格的 `+N`。空列表回 null(块收起 —— 画一个空的图廊壳不如
 * 整块收起)。
 *
 * `Post` 与拓展共用这一份(决策 68):`nodeFromPost` 把 `PostImage` 映射成同一种列表再调它。
 */
export function buildGallery(images: readonly GalleryImage[]): VNode | null {
	if (images.length === 0) return null;
	if (images.length === 1) {
		const pic = images[0];
		const isSuperLong = tallerThan(pic, 2);
		const isLong = !isSuperLong && tallerThan(pic, 1);
		const badge = picBadgeText(pic, isSuperLong);
		// 三种形态各自的图框宽高都不一样,角标就近挂在各自那层 —— 统一提到最外层的话,
		// 竖图(width:auto)那支会把角标甩到图片右侧的空白里去。
		const badgeEl = () =>
			badge ? (
				<div class="absolute bottom-2 right-2 bg-black/50 text-white text-[13px] px-[8px] py-[4px] rounded leading-none">
					{badge}
				</div>
			) : null;
		return (
			// 单图时整个图廊就是那一格,两个挂点落在同一个元素上。
			<div data-bn="pics pic" class="relative overflow-hidden rounded-lg" style="max-width: 600px;">
				{isSuperLong ? (
					<div class="relative" style="height: 400px; overflow: hidden;">
						<img class="w-full h-full object-cover object-top block" src={pic.url} alt="" />
						{badgeEl()}
					</div>
				) : isLong ? (
					<div class="relative inline-block">
						<img
							class="h-auto block rounded-lg"
							style="max-height: 400px; width: auto;"
							src={pic.url}
							alt=""
						/>
						{badgeEl()}
					</div>
				) : (
					<>
						<img class="w-full h-auto block" src={pic.url} alt="" />
						{badgeEl()}
					</>
				)}
			</div>
		);
	}

	// 超出 9 张的部分不铺格子,折进最后一格的 `+N`。以前是有几张铺几张,十几张图的
	// 动态能把卡片拉出一米多长,推到群里就是一堵缩略图墙。
	const shown = images.slice(0, MAX_GRID_PICS);
	const overflow = images.length - shown.length;
	const is2col = shown.length === 2 || shown.length === 4;
	// 多图总宽与单图对齐（max 480px），图片在其中平分，gap 8px
	const containerClass = is2col
		? "relative w-[calc(50%-4px)] aspect-square shrink-0"
		: "relative w-[calc(33.33%-6px)] aspect-square shrink-0";
	return (
		<div data-bn="pics" class="flex flex-wrap gap-[8px]" style="max-width: 600px;">
			{shown.map((p, i) => {
				const isLong = tallerThan(p, 2);
				const badge = picBadgeText(p, isLong);
				// `+N` 盖在**第 9 张图上**,不另起一格 —— 另起就成了 10 格,末格空着,
				// 三列也就散了。
				const more = overflow > 0 && i === shown.length - 1 ? overflow : 0;
				return (
					<div key={i} data-bn="pic" class={containerClass}>
						<img
							class={`w-full h-full object-cover ${isLong ? "object-top" : ""} rounded`}
							src={p.url}
							alt=""
						/>
						{more > 0 && (
							// 遮罩压到 40% —— 再深就成了整格纯黑,九宫格里凭空多出一块深色补丁,
							// 比它盖住的那张图还抢眼。压浅之后白字在亮图上会发虚,靠一层文字投影兜住。
							//
							// 投影**属性写在 class 上、值留在 inline 的变量里**(与那 33 处颜色同一套,
							// ADR-0014 决策 13 的 🔗):整条写成 inline 的话皮肤永远压不过它 —— 清洗器
							// 一律摘 `!important`,而 inline 恒赢。类名里不写那串带逗号的值,是因为
							// UnoCSS 的切词按分隔符走,`rgba(0,0,0,.55)` 进类名要赌它怎么切。
							<div
								class="absolute inset-0 flex items-center justify-center rounded bg-black/40 text-white text-[28px] font-bold leading-none [text-shadow:var(--bn-pics-more-shadow)]"
								style="--bn-pics-more-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);"
							>
								{`+${more}`}
							</div>
						)}
						{badge && (
							<div class="absolute bottom-1 right-1 bg-black/50 text-white text-[10px] px-[5px] py-[2px] rounded-sm leading-none">
								{badge}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
