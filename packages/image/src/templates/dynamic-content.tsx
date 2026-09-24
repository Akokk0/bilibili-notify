/** @jsxImportSource vue */

/**
 * 一条动态的「呈现态」构建器。
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

import type { VNode } from "vue";
import { SVG_BELL, SVG_GOODS, SVG_LOTTERY } from "../icons";
import { parseRichText } from "../rich-text";
import type { Dynamic, RichTextNode } from "../types";

// ── 动态类型常量 ──────────────────────────────────────────────────────────────

const DYNAMIC_TYPE_NONE = "DYNAMIC_TYPE_NONE";
const DYNAMIC_TYPE_FORWARD = "DYNAMIC_TYPE_FORWARD";
const DYNAMIC_TYPE_AV = "DYNAMIC_TYPE_AV";
const DYNAMIC_TYPE_PGC = "DYNAMIC_TYPE_PGC";
const DYNAMIC_TYPE_WORD = "DYNAMIC_TYPE_WORD";
const DYNAMIC_TYPE_DRAW = "DYNAMIC_TYPE_DRAW";
const DYNAMIC_TYPE_ARTICLE = "DYNAMIC_TYPE_ARTICLE";
const DYNAMIC_TYPE_MUSIC = "DYNAMIC_TYPE_MUSIC";
const DYNAMIC_TYPE_COMMON_SQUARE = "DYNAMIC_TYPE_COMMON_SQUARE";
const DYNAMIC_TYPE_LIVE = "DYNAMIC_TYPE_LIVE";
const DYNAMIC_TYPE_MEDIALIST = "DYNAMIC_TYPE_MEDIALIST";
const DYNAMIC_TYPE_COURSES_SEASON = "DYNAMIC_TYPE_COURSES_SEASON";
const DYNAMIC_TYPE_LIVE_RCMD = "DYNAMIC_TYPE_LIVE_RCMD";
const DYNAMIC_TYPE_UGC_SEASON = "DYNAMIC_TYPE_UGC_SEASON";
const ADDITIONAL_TYPE_RESERVE = "ADDITIONAL_TYPE_RESERVE";
const ADDITIONAL_TYPE_GOODS = "ADDITIONAL_TYPE_GOODS";
const ADDITIONAL_TYPE_COMMON = "ADDITIONAL_TYPE_COMMON";
const ADDITIONAL_TYPE_UGC = "ADDITIONAL_TYPE_UGC";

/** 时间戳 / 数字的格式化器(由 image-renderer 注入,保持模版层纯净)。 */
export type NodeFormatters = {
	time: (ts: number) => string;
	num: (n: number) => string;
};

/**
 * 一条动态的「呈现态」结构树 —— 与原始 B站 API 解耦,供 DynamicCard 按版式块装配。
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
 * 投稿视频那张卡的数据。播放 / 弹幕数接口可能已给成 "6.5万",原样转文本,不做算术。
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
 * 图廊里的一张图 —— **中立的形状**(ADR-0019 决策 68)。B 站与拓展都先映射成它,再交给
 * {@link buildGallery};图廊只有那一份实现。
 *
 * - 宽高缺了就不判长图,按普通比例铺(拓展的图宽高由 BN 读文件头拿,读不出来也照样出卡)。
 * - `animated` 由来源自己判:B 站看 `live_url` 或 `.gif` 结尾,拓展看交来的 MIME ——
 *   拓展的图是 data URL,「看结尾」那一招对它不成立。
 */
export type GalleryImage = {
	url: string;
	width?: number;
	height?: number;
	animated?: boolean;
};

export type DynamicNode = {
	avatarUrl: string;
	upName: string;
	upIsVip: boolean;
	pubTime: string;
	/**
	 * 动态类型(`DYNAMIC_TYPE_*`),皮肤契约的 `dynamic.type`。造 node 时顺手记下(决策 68)——
	 * 从前契约回头去 B 站原始数据里取,出卡入口因此得另收一份原始数据。拓展作品套进 B 站的
	 * 类型(决策 69)。不给就是空串。
	 */
	type?: string;
	/** 作为内部转发渲染时,附在作者名后的类型标签(如「投稿了视频」)。 */
	headerLabel?: string;
	topic?: string;
	/**
	 * 正文文字,进 `text` 原子块:desc / opus 摘要的富文本(专栏连标题),转发是转发语,充电专属
	 * 是那块占位,渲染不了的是那句提示。一个字都没有(只发了图)时为空。
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
 * 把一条动态构建成 DynamicNode 结构树。
 * @param dynamic 动态数据
 * @param isForward 是否作为被转发的内部动态(影响标签位置、是否带互动数)
 * @param fmt 时间 / 数字格式化器
 */
export async function buildDynamicNode(
	dynamic: Dynamic,
	isForward: boolean,
	fmt: NodeFormatters,
): Promise<DynamicNode> {
	const author = dynamic.modules.module_author;
	const stat = dynamic.modules.module_stat;
	const node: DynamicNode = {
		avatarUrl: author.face,
		upName: author.name,
		upIsVip: author.vip.type !== 0,
		pubTime: fmt.time(author.pub_ts),
		type: dynamic.type,
		topic: dynamic.modules.module_dynamic.topic?.name || undefined,
		additional: buildAdditionalContent(dynamic),
		// 内部转发不展示互动数(与原行为一致,版式上 stats 块自动收起)。
		stats: isForward
			? undefined
			: {
					forward: fmt.num(stat.forward.count),
					comment: fmt.num(stat.comment.count),
					like: fmt.num(stat.like.count),
				},
	};
	const upName = author.name;

	// 充电专属且未充电:接口把 module_dynamic 整体清空,不管外层 type 是什么,
	// 落进下面任何一个分支都只会渲染出空白正文。在类型分发之前短路,渲染占位
	// 提示而非空白——递归到内部转发(orig)时同样生效,无需额外处理。
	if (isChargeOnlyLocked(dynamic)) {
		node.text = buildChargeOnlyText(author);
		return node;
	}

	// 给节点贴类型标签:外层接到发布时间后,内部转发接到作者名后。
	const label = (text: string) => {
		if (isForward) node.headerLabel = text;
		else node.pubTime += ` · ${text}`;
	};

	// 「我暂时无法渲染」那一类:正文只有一句提示。
	const notice = (v: VNode) => {
		node.text = v;
	};

	switch (dynamic.type) {
		case DYNAMIC_TYPE_WORD:
		case DYNAMIC_TYPE_DRAW: {
			node.text = buildBasicText(dynamic, false);
			node.images = opusImages(dynamic);
			return node;
		}

		case DYNAMIC_TYPE_FORWARD: {
			// 转发本身不带图(接口给的 major 是空的),照样取一遍,真有也不丢。
			node.images = opusImages(dynamic);
			if (!dynamic.orig) {
				// 没有转发框可装这句说明,它跟着转发语走。
				node.text = (
					<>
						{buildBasicText(dynamic, false)}
						<p>{upName}转发了一条动态，但原动态已不可见</p>
					</>
				);
				return node;
			}
			node.text = buildBasicText(dynamic, false);
			node.forward = await buildDynamicNode(dynamic.orig, true, fmt);
			return node;
		}

		case DYNAMIC_TYPE_AV: {
			const archive = dynamic.modules.module_dynamic?.major?.archive;
			node.text = buildBasicText(dynamic, false);
			node.video = archive ? videoOf(archive) : null;
			if (archive?.badge.text === "投稿视频") label("投稿了视频");
			return node;
		}

		case DYNAMIC_TYPE_ARTICLE: {
			node.text = buildBasicText(dynamic, true);
			node.images = opusImages(dynamic);
			label("投稿了专栏");
			return node;
		}

		case DYNAMIC_TYPE_LIVE:
			notice(<p>{upName}发起了直播预约，我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_MEDIALIST:
			notice(<p>{upName}分享了收藏夹，我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_PGC:
			notice(<p>{upName}发布了剧集（番剧、电影、纪录片），我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_MUSIC:
			notice(<p>{upName}发行了新歌，我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_COMMON_SQUARE:
			notice(<p>{upName}发布了装扮｜剧集｜点评｜普通分享，我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_COURSES_SEASON:
			notice(<p>{upName}发布了新课程，我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_UGC_SEASON:
			notice(<p>{upName}更新了合集，我暂时无法渲染，请自行查看</p>);
			break;
		case DYNAMIC_TYPE_NONE:
			notice(<p>{upName}发布了一条无效动态</p>);
			break;
		case DYNAMIC_TYPE_LIVE_RCMD:
			// 顶层的开播动态动态引擎按类型先跳过了(ADR-0019 决策 66),撞到这里的只剩卡片页的
			// 真实预览,照旧抛。转发里的那条跳不掉:抛了整张转发卡都出不来,当一句提示画。
			if (!isForward) throw new Error("直播开播动态，不做处理");
			notice(<p>{upName}发布了一条开播动态，我暂时无法渲染，请自行查看</p>);
			break;
		default:
			notice(<p>{upName}发布了一条我无法识别的动态，请自行查看</p>);
	}
	// 「无法渲染」类动态没有可拆的附加内容,清掉以免空块占位。
	node.additional = null;
	return node;
}

// ── 充电专属占位 ──────────────────────────────────────────────────────────────

/**
 * 是否「充电专属且当前不可见」:`basic.is_only_fans` 为真,且 module_dynamic
 * 被接口整体清空(desc/major/topic/additional 全缺席)。已充电用户拉到的同一条
 * 动态 `is_only_fans` 也是 true,但内容齐全,不会命中——按内容有无判定,不按
 * type,避免漏判某个具体的 DYNAMIC_TYPE_* 变体。
 */
function isChargeOnlyLocked(dynamic: Dynamic): boolean {
	if (!dynamic.basic?.is_only_fans) return false;
	const mod = dynamic.modules.module_dynamic;
	return !mod?.desc && !mod?.major && !mod?.topic && !mod?.additional;
}

/** 充电专属占位正文:优先用接口带的徽标图 / 文案,缺席时用固定文案兜底。 */
function buildChargeOnlyText(author: Dynamic["modules"]["module_author"]) {
	const badge = author.icon_badge;
	return (
		<div class="flex flex-col items-center justify-center gap-[8px] py-[20px] text-center">
			{badge?.icon ? <img class="w-[28px] h-[28px]" src={badge.icon} alt="" /> : null}
			<div class="text-[14px] font-bold [color:var(--bn-accent)]" style="--bn-accent: #FB7299;">
				{badge?.text || "充电专属内容"}
			</div>
			<div class="text-[12px] [color:var(--bn-ink-faint)]" style="--bn-ink-faint: #999;">
				为 {author.name} 充电即可查看完整内容
			</div>
		</div>
	);
}

// ── 私有辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 正文文字:desc 富文本 + opus 摘要富文本(专栏带标题)。两件都有时才包 Fragment,只有
 * 一件就直接给它 —— 少一对 `<!--[-->` 锚点。
 */
function buildBasicText(dynamic: Dynamic, isArticle: boolean): VNode | null {
	const mod = dynamic.modules.module_dynamic;
	const desc =
		mod?.desc?.rich_text_nodes && parseRichText(mod.desc.rich_text_nodes, undefined, isArticle);
	const summary =
		mod?.major?.opus?.summary?.rich_text_nodes &&
		parseRichText(mod.major.opus.summary.rich_text_nodes, mod.major.opus.title, isArticle);
	if (desc && summary) {
		return (
			<>
				{desc}
				{summary}
			</>
		);
	}
	return desc || summary || null;
}

/**
 * **纯文本正文** → `text` 块的那一份(ADR-0019 决策 68,给拓展作品用)。保留换行;标签原样
 * 当文字(转义)。
 *
 * 走的是 B 站富文本**同一个根**(`body` 挂点、同一套 class、同样超 9 行截断):切成富文本节点交给
 * {@link parseRichText},皮肤给正文写的规则两边一套,不必为拓展另写一份。
 *
 * `topics` 是来源报的话题名(决策 55 的 09-24 🔗):正文里的 `#名字#` / `#名字` 切成 B 站富文本
 * **同一种话题节点**,画出来是同一种 span。只照这份名单找 —— 不在名单里的 `#`(「C#」「#1」)
 * 一律当文字,BN 不按 `#` 自己猜。
 *
 * 一个字都没有(空串 / 只有空白)回 null,正文块收起。
 */
export function buildPlainText(text: string, topics: readonly string[] = []): VNode | null {
	const normalized = text.replace(/\r\n?/g, "\n");
	if (normalized.trim() === "") return null;
	return parseRichText(plainTextNodes(normalized, topics));
}

/**
 * 纯文本按话题名切成富文本节点:话题一段是话题节点,其余是文字节点。
 *
 * 同一处能对上几种写法时取排在前面的:名字长的先(「旅行日记」与「旅行」都报了,`#旅行日记` 整个是
 * 话题),同一个名字 `#名字#` 先于 `#名字`(收尾的 `#` 算进话题)。只在 `#` 所在的位置上试。
 */
function plainTextNodes(text: string, topics: readonly string[]): RichTextNode {
	const patterns = [...new Set(topics)]
		.filter((name) => name !== "")
		.sort((a, b) => b.length - a.length)
		.flatMap((name) => [`#${name}#`, `#${name}`]);
	const nodes: RichTextNode = [];
	const push = (type: string, part: string) => {
		if (part) nodes.push({ type, text: part, orig_text: part });
	};
	let plainFrom = 0;
	let at = patterns.length > 0 ? text.indexOf("#") : -1;
	while (at !== -1) {
		const hit = patterns.find((pattern) => text.startsWith(pattern, at));
		if (hit) {
			push("RICH_TEXT_NODE_TYPE_TEXT", text.slice(plainFrom, at));
			push("RICH_TEXT_NODE_TYPE_TOPIC", hit);
			plainFrom = at + hit.length;
			at = text.indexOf("#", plainFrom);
		} else {
			at = text.indexOf("#", at + 1);
		}
	}
	push("RICH_TEXT_NODE_TYPE_TEXT", text.slice(plainFrom));
	return nodes;
}

/** 图廊最多铺几格 —— 与 B 站网页端一致,余下的折进最后一格的 `+N`。 */
const MAX_GRID_PICS = 9;

type OpusPic = { height: number; url: string; width: number; live_url?: string };

/**
 * B 站图文 / 专栏的图 → 图廊吃的中立列表(决策 68)。没有图给空数组,`pics` 块自己收起。
 */
function opusImages(dynamic: Dynamic): GalleryImage[] {
	const pics = dynamic.modules.module_dynamic?.major?.opus?.pics ?? [];
	return pics.map((p) => ({
		url: p.url,
		width: p.width,
		height: p.height,
		animated: isAnimatedOpusPic(p),
	}));
}

/**
 * B 站的这张图会不会动。
 *
 * 两条判据取并集:`live_url` 非空(B 站给动图带的播放地址)**或** URL 后缀是 `.gif`。
 * 只认一条的话,万一它在某类动态里不成立就是整片漏标;两条都不满足才不标 —— 宁可漏
 * 也不误标,把静图标成动图更让人费解。
 */
function isAnimatedOpusPic(p: OpusPic): boolean {
	if (p.live_url) return true;
	// 真实 URL 常带处理后缀和 query(`….gif@1280w_80q_1s.webp?from=dyn`),直接看结尾
	// 会把 GIF 认成 webp 而漏标 —— 先把这两截削掉。
	const path = p.url.split("?")[0].split("@")[0];
	return path.toLowerCase().endsWith(".gif");
}

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
 * B 站与拓展共用这一份(决策 68):B 站先经 `opusImages` 映射成同一种列表再调它。
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

/**
 * 附加内容(预约 / 商品 / 通用卡 / 关联视频)。返回内层 VNode(无外边距 —— 间距由
 * additional 版式块的 marginTop 控制),无附加内容时返回 null(块自动收起)。
 */
function buildAdditionalContent(dynamic: Dynamic): VNode | null {
	const additional = dynamic.modules.module_dynamic.additional;
	if (!additional) return null;
	switch (additional.type) {
		case ADDITIONAL_TYPE_RESERVE:
			return buildReserveAdditional(additional.reserve);
		case ADDITIONAL_TYPE_GOODS:
			return buildGoodsAdditional(additional.goods);
		case ADDITIONAL_TYPE_COMMON:
			return buildCommonAdditional(additional.common);
		case ADDITIONAL_TYPE_UGC:
			// type 说是 UGC 但 ugc 缺席的情况真实存在(接口降级),没内容就当没附加块。
			return additional.ugc ? buildUgcAdditional(additional.ugc) : null;
		default:
			return null;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回的预约数据类型不固定
function buildReserveAdditional(reserve: any) {
	const isEnded = reserve.button.uncheck.text === "已结束";
	return (
		<div
			data-bn="card"
			class="flex justify-between items-center gap-[10px] bg-black/4 rounded-lg p-[10px]"
		>
			<div class="flex-1 min-w-0">
				<div class="text-[14px] font-bold text-[#18191C] mb-1">{reserve.title}</div>
				<div class="flex gap-2 text-[12px] text-[#999]">
					<span>{reserve.desc1.text}</span>
					<span>{reserve.desc2.text}</span>
				</div>
				{reserve.desc3 && (
					<div class="flex items-center gap-1 text-[12px] text-[#FF6699] mt-1">
						{SVG_LOTTERY}
						<span>{reserve.desc3.text}</span>
					</div>
				)}
			</div>
			<div
				data-bn="button"
				class={`shrink-0 inline-flex items-center gap-1 px-3 py-[6px] rounded-[6px] text-[12px] font-bold leading-none ${
					isEnded ? "bg-[#f5f5f5] text-[#999]" : "bg-[#FB7299] text-white"
				}`}
			>
				{!isEnded && SVG_BELL}
				<span>{reserve.button.uncheck.text}</span>
			</div>
		</div>
	);
}

// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回的商品数据类型不固定
function buildGoodsAdditional(goods: any) {
	const isSingle = goods.items.length === 1;
	return (
		<div>
			<div class="flex items-center gap-1 text-[12px] text-[#999] mb-[6px]">
				{SVG_GOODS}
				{goods.head_text}
			</div>
			<div data-bn="card" class="bg-black/4 rounded-lg p-[10px]">
				{isSingle ? (
					<div class="flex gap-[10px] items-center">
						<div class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden">
							<img
								data-bn="cover"
								class="w-full h-full object-cover"
								src={goods.items[0].cover}
								alt=""
							/>
						</div>
						<div class="flex-1 min-w-0">
							<div class="text-[13px] text-[#18191C] line-clamp-2 mb-[6px]">
								{goods.items[0].name}
							</div>
							<div class="flex items-baseline gap-[2px]">
								<span class="text-[14px] text-[#FF6699] font-bold">{goods.items[0].price}</span>
								<span class="text-[12px] text-[#999]">起</span>
							</div>
						</div>
						<div
							data-bn="button"
							class="shrink-0 px-[14px] py-[6px] rounded-[6px] bg-[#FB7299] text-white text-[12px] font-bold leading-none"
						>
							{goods.items[0].jump_desc || "去看看"}
						</div>
					</div>
				) : (
					<div class="flex gap-[8px] flex-wrap">
						{/* biome-ignore lint/suspicious/noExplicitAny: Bilibili goods API returns untyped items */}
						{goods.items.map((item: any, i: number) => (
							<div key={i} class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden bg-black/8">
								<img data-bn="cover" class="w-full h-full object-cover" src={item.cover} alt="" />
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回的通用卡片数据类型不固定
function buildCommonAdditional(common: any) {
	const subTypeLabel: Record<string, string> = { game: "游戏" };
	const label = subTypeLabel[common.sub_type] ?? common.sub_type;
	return (
		<div>
			<div class="flex items-center gap-1 text-[12px] text-[#999] mb-[6px]">{common.head_text}</div>
			<div data-bn="card" class="bg-black/4 rounded-lg p-[10px]">
				<div class="flex gap-[10px] items-center">
					<div class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden">
						<img data-bn="cover" class="w-full h-full object-cover" src={common.cover} alt="" />
					</div>
					<div class="flex-1 min-w-0">
						<div class="text-[13px] font-bold text-[#18191C] mb-[4px]">{common.title}</div>
						{common.desc1 && (
							<div class="flex items-center gap-[4px] mb-[2px]">
								{label && (
									<span class="text-[10px] text-[#FB7299] border border-[#FB7299] px-[3px] py-[1px] rounded-sm leading-none shrink-0">
										{label}
									</span>
								)}
								<span class="text-[12px] text-[#999] truncate">{common.desc1}</span>
							</div>
						)}
						{common.desc2 && <div class="text-[12px] text-[#999] truncate">{common.desc2}</div>}
					</div>
					{common.button?.jump_style?.text && (
						<div
							data-bn="button"
							class="shrink-0 px-[14px] py-[6px] rounded-[6px] bg-[#FB7299] text-white text-[12px] font-bold leading-none"
						>
							{common.button.jump_style.text}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * 关联视频卡 —— 图文/文字动态正文下方挂的那条投稿。
 *
 * 与 DYNAMIC_TYPE_AV 的主视频卡(拆成了五个原子块)是两套数据:那边 `stat.play` /
 * `stat.danmaku` 是两个各自配图标的计数(接口给的是「6.5万」这种成品字符串;链接解析
 * 拼出来的动态也照这个样子给),这边 `desc_second` 已经是接口拼好的一整句(「2654观看
 * 102弹幕」),官方页面也是当纯文本灰字渲染的,别再套图标重排。
 */
// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回的关联视频数据类型不固定
function buildUgcAdditional(ugc: any) {
	return (
		<div>
			{/* head_text 在抓包里常为空串,空就整行不渲染,免得多出一条空白灰字。 */}
			{ugc.head_text && (
				<div class="flex items-center gap-1 text-[12px] text-[#999] mb-[6px]">{ugc.head_text}</div>
			)}
			<div data-bn="card" class="bg-black/4 rounded-lg p-[10px]">
				<div class="flex gap-[10px] items-center">
					<div class="relative w-[140px] h-[80px] shrink-0 rounded-md overflow-hidden bg-black/8">
						<img data-bn="cover" class="w-full h-full object-cover block" src={ugc.cover} alt="" />
						{/*
						 * 角标衬一层深色底,不是只给文字加 text-shadow —— 封面右下角是什么颜色
						 * 完全由 UP 决定,遇上亮底(放射光、白背景)白字加弱阴影就糊没了。
						 * 主视频卡靠整张压暗 bg-black/20 兜住,这里封面小、压暗会让整卡发灰,
						 * 改成只在角标下垫一块。
						 */}
						{ugc.duration && (
							<span class="absolute bottom-[4px] right-[4px] px-[4px] py-[1px] rounded-[3px] bg-black/60 text-white text-[11px] font-bold leading-[1.4]">
								{ugc.duration}
							</span>
						)}
					</div>
					<div class="flex-1 min-w-0">
						<div class="text-[13px] font-bold text-[#18191C] line-clamp-2 mb-[6px]">
							{ugc.title}
						</div>
						{ugc.desc_second && (
							<div class="text-[12px] text-[#999] truncate">{ugc.desc_second}</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * 投稿视频那张卡的数据(决策 8 的 2026-09-18 🔗)。从前这里画的是一整张卡,现在只取数 ——
 * 卡由 `blocks/dynamic.tsx` 的五个原子块各画一段、皮肤用网格与 CSS 拼回去。
 */
function videoOf(archive: {
	cover: string;
	duration_text: string;
	title: string;
	desc: string;
	stat: { play: number | string; danmaku: number | string };
}): DynamicVideo {
	return {
		cover: archive.cover,
		duration: archive.duration_text,
		title: archive.title,
		desc: archive.desc,
		views: String(archive.stat.play),
		danmaku: String(archive.stat.danmaku),
	};
}
