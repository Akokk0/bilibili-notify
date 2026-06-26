/** @jsxImportSource vue */
import type { VNode } from "vue";
import { SVG_BELL, SVG_DANMAKU, SVG_GOODS, SVG_LOTTERY, SVG_VIEW } from "../icons";
import { parseRichText } from "../rich-text";
import type { Dynamic } from "../types";

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
 */
export type DynamicNode = {
	avatarUrl: string;
	upName: string;
	upIsVip: boolean;
	pubTime: string;
	/** 作为内部转发渲染时,附在作者名后的类型标签(如「投稿了视频」)。 */
	headerLabel?: string;
	topic?: string;
	body: VNode;
	additional?: VNode | null;
	forward?: DynamicNode;
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
		topic: dynamic.modules.module_dynamic.topic?.name || undefined,
		body: <></>,
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

	// 给节点贴类型标签:外层接到发布时间后,内部转发接到作者名后。
	const label = (text: string) => {
		if (isForward) node.headerLabel = text;
		else node.pubTime += ` · ${text}`;
	};

	switch (dynamic.type) {
		case DYNAMIC_TYPE_WORD:
		case DYNAMIC_TYPE_DRAW: {
			node.body = buildBasicContent(dynamic, false);
			return node;
		}

		case DYNAMIC_TYPE_FORWARD: {
			const selfContent = buildBasicContent(dynamic, false);
			if (!dynamic.orig) {
				node.body = (
					<>
						{selfContent}
						<p>{upName}转发了一条动态，但原动态已不可见</p>
					</>
				);
				return node;
			}
			node.body = selfContent;
			node.forward = await buildDynamicNode(dynamic.orig, true, fmt);
			return node;
		}

		case DYNAMIC_TYPE_AV: {
			const selfContent = buildBasicContent(dynamic, false);
			const archive = dynamic.modules.module_dynamic?.major?.archive;
			node.body = archive ? (
				<>
					{selfContent}
					{buildVideoContent(archive)}
				</>
			) : (
				selfContent
			);
			if (archive?.badge.text === "投稿视频") label("投稿了视频");
			return node;
		}

		case DYNAMIC_TYPE_ARTICLE: {
			node.body = buildBasicContent(dynamic, true);
			label("投稿了专栏");
			return node;
		}

		case DYNAMIC_TYPE_LIVE:
			node.body = <p>{upName}发起了直播预约，我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_MEDIALIST:
			node.body = <p>{upName}分享了收藏夹，我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_PGC:
			node.body = <p>{upName}发布了剧集（番剧、电影、纪录片），我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_MUSIC:
			node.body = <p>{upName}发行了新歌，我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_COMMON_SQUARE:
			node.body = <p>{upName}发布了装扮｜剧集｜点评｜普通分享，我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_COURSES_SEASON:
			node.body = <p>{upName}发布了新课程，我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_UGC_SEASON:
			node.body = <p>{upName}更新了合集，我暂时无法渲染，请自行查看</p>;
			break;
		case DYNAMIC_TYPE_NONE:
			node.body = <p>{upName}发布了一条无效动态</p>;
			break;
		case DYNAMIC_TYPE_LIVE_RCMD:
			throw new Error("直播开播动态，不做处理");
		default:
			node.body = <p>{upName}发布了一条我无法识别的动态，请自行查看</p>;
	}
	// 「无法渲染」类动态没有可拆的附加内容,清掉以免空块占位。
	node.additional = null;
	return node;
}

// ── 私有辅助函数 ──────────────────────────────────────────────────────────────

function buildBasicContent(dynamic: Dynamic, isArticle: boolean) {
	const mod = dynamic.modules.module_dynamic;
	return (
		<>
			{mod?.desc?.rich_text_nodes && parseRichText(mod.desc.rich_text_nodes, undefined, isArticle)}
			{mod?.major?.opus?.summary?.rich_text_nodes &&
				parseRichText(mod.major.opus.summary.rich_text_nodes, mod.major.opus.title, isArticle)}
			{mod?.major?.opus?.pics && (
				<div class="mt-[8px]">{buildPicsContent(mod.major.opus.pics)}</div>
			)}
		</>
	);
}

function buildPicsContent(pics: Array<{ height: number; url: string; width: number }>) {
	if (pics.length === 1) {
		const pic = pics[0];
		const isSuperLong = pic.height > pic.width * 2;
		const isLong = !isSuperLong && pic.height > pic.width;
		return (
			<div class="relative overflow-hidden rounded-lg" style="max-width: 600px;">
				{isSuperLong ? (
					<div class="relative" style="height: 400px; overflow: hidden;">
						<img class="w-full h-full object-cover object-top block" src={pic.url} alt="" />
						<div class="absolute bottom-2 right-2 bg-black/50 text-white text-[13px] px-[8px] py-[4px] rounded leading-none">
							长图
						</div>
					</div>
				) : isLong ? (
					<img
						class="h-auto block rounded-lg"
						style="max-height: 400px; width: auto;"
						src={pic.url}
						alt=""
					/>
				) : (
					<img class="w-full h-auto block" src={pic.url} alt="" />
				)}
			</div>
		);
	}

	const is2col = pics.length === 2 || pics.length === 4;
	// 多图总宽与单图对齐（max 480px），图片在其中平分，gap 8px
	const containerClass = is2col
		? "relative w-[calc(50%-4px)] aspect-square shrink-0"
		: "relative w-[calc(33.33%-6px)] aspect-square shrink-0";
	return (
		<div class="flex flex-wrap gap-[8px]" style="max-width: 600px;">
			{pics.map((p, i) => {
				const isLong = p.height > p.width * 2;
				return (
					<div key={i} class={containerClass}>
						<img
							class={`w-full h-full object-cover ${isLong ? "object-top" : ""} rounded`}
							src={p.url}
							alt=""
						/>
						{isLong && (
							<div class="absolute bottom-1 right-1 bg-black/50 text-white text-[10px] px-[5px] py-[2px] rounded-sm leading-none">
								长图
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/**
 * 附加内容(预约 / 商品 / 通用卡)。返回内层 VNode(无外边距 —— 间距由 additional
 * 版式块的 marginTop/marginBottom 控制),无附加内容时返回 null(块自动收起)。
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
		default:
			return null;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回的预约数据类型不固定
function buildReserveAdditional(reserve: any) {
	const isEnded = reserve.button.uncheck.text === "已结束";
	return (
		<div class="flex justify-between items-center gap-[10px] bg-black/4 rounded-lg p-[10px]">
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
			<div class="bg-black/4 rounded-lg p-[10px]">
				{isSingle ? (
					<div class="flex gap-[10px] items-center">
						<div class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden">
							<img class="w-full h-full object-cover" src={goods.items[0].cover} alt="" />
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
						<div class="shrink-0 px-[14px] py-[6px] rounded-[6px] bg-[#FB7299] text-white text-[12px] font-bold leading-none">
							{goods.items[0].jump_desc || "去看看"}
						</div>
					</div>
				) : (
					<div class="flex gap-[8px] flex-wrap">
						{/* biome-ignore lint/suspicious/noExplicitAny: Bilibili goods API returns untyped items */}
						{goods.items.map((item: any, i: number) => (
							<div key={i} class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden bg-black/8">
								<img class="w-full h-full object-cover" src={item.cover} alt="" />
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
			<div class="bg-black/4 rounded-lg p-[10px]">
				<div class="flex gap-[10px] items-center">
					<div class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden">
						<img class="w-full h-full object-cover" src={common.cover} alt="" />
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
						<div class="shrink-0 px-[14px] py-[6px] rounded-[6px] bg-[#FB7299] text-white text-[12px] font-bold leading-none">
							{common.button.jump_style.text}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function buildVideoContent(archive: {
	cover: string;
	duration_text: string;
	title: string;
	desc: string;
	stat: { play: number; danmaku: number };
}) {
	return (
		<div
			class="flex gap-[10px] rounded-lg overflow-hidden mt-1"
			style="background: rgba(0,0,0,0.04); max-width: 600px;"
		>
			<div class="relative w-40 shrink-0">
				<img class="w-full h-full object-cover block" src={archive.cover} alt="" />
				<div class="absolute inset-0 bg-black/20" />
				<span class="absolute bottom-1 right-[6px] text-white text-[11px] font-bold [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
					{archive.duration_text}
				</span>
			</div>
			<div class="flex-1 min-w-0 py-[10px] pr-[10px] flex flex-col justify-between">
				<div>
					<div class="text-[14px] font-bold text-[#18191C] line-clamp-2 mb-1">{archive.title}</div>
					<div class="text-[12px] text-[#999] line-clamp-2">{archive.desc}</div>
				</div>
				<div class="flex gap-3 text-[12px] text-[#999] items-center">
					<span class="flex items-center gap-[4px]">
						{SVG_VIEW}
						{archive.stat.play}
					</span>
					<span class="flex items-center gap-[4px]">
						{SVG_DANMAKU}
						{archive.stat.danmaku}
					</span>
				</div>
			</div>
		</div>
	);
}
