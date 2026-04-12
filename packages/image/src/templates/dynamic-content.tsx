/** @jsxImportSource vue */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VNode } from "vue";
import { SVG_DANMAKU, SVG_GOODS, SVG_LOTTERY, SVG_VIEW } from "../icons";
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

/** buildDynamicContent 的返回值 */
export type DynamicContent = {
	vnode: VNode;
	forwardLabel?: string;
	pubTimeSuffix?: string;
};

/**
 * 根据动态类型构建内容 VNode
 * @param dynamic 动态数据
 * @param isForward 是否作为被转发动态
 * @param dirname 调用方的 __dirname，用于定位静态资源
 */
export async function buildDynamicContent(
	dynamic: Dynamic,
	isForward: boolean,
	dirname: string,
): Promise<DynamicContent> {
	const upName = dynamic.modules.module_author.name;

	switch (dynamic.type) {
		case DYNAMIC_TYPE_WORD:
		case DYNAMIC_TYPE_DRAW: {
			return { vnode: buildBasicContent(dynamic, false, dirname) };
		}

		case DYNAMIC_TYPE_FORWARD: {
			const selfContent = buildBasicContent(dynamic, false, dirname);
			if (!dynamic.orig)
				return {
					vnode: (
						<>
							{selfContent}
							<p>{upName}转发了一条动态，但原动态已不可见</p>
						</>
					),
				};
			const forwarded = await buildDynamicContent(dynamic.orig, true, dirname);
			const forwardedAuthor = dynamic.orig.modules.module_author;
			return {
				vnode: (
					<>
						{selfContent}
						{buildAdditionalContent(dynamic)}
						{buildForwardBlock(
							forwardedAuthor.face,
							forwardedAuthor.name,
							forwarded.forwardLabel,
							forwarded.vnode,
						)}
					</>
				),
			};
		}

		case DYNAMIC_TYPE_AV: {
			const selfContent = buildBasicContent(dynamic, false, dirname);
			if (!dynamic.modules.module_dynamic?.major?.archive) return { vnode: selfContent };
			const archive = dynamic.modules.module_dynamic.major.archive;
			const isNewVideo = archive.badge.text === "投稿视频";
			return {
				vnode: (
					<>
						{selfContent}
						{buildVideoContent(archive)}
					</>
				),
				forwardLabel: isNewVideo && isForward ? "投稿了视频" : undefined,
				pubTimeSuffix: isNewVideo && !isForward ? " · 投稿了视频" : undefined,
			};
		}

		case DYNAMIC_TYPE_ARTICLE: {
			return {
				vnode: buildBasicContent(dynamic, true, dirname),
				forwardLabel: isForward ? "投稿了专栏" : undefined,
				pubTimeSuffix: !isForward ? " · 投稿了专栏" : undefined,
			};
		}

		case DYNAMIC_TYPE_LIVE:
			return { vnode: <p>{upName}发起了直播预约，我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_MEDIALIST:
			return { vnode: <p>{upName}分享了收藏夹，我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_PGC:
			return { vnode: <p>{upName}发布了剧集（番剧、电影、纪录片），我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_MUSIC:
			return { vnode: <p>{upName}发行了新歌，我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_COMMON_SQUARE:
			return { vnode: <p>{upName}发布了装扮｜剧集｜点评｜普通分享，我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_COURSES_SEASON:
			return { vnode: <p>{upName}发布了新课程，我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_UGC_SEASON:
			return { vnode: <p>{upName}更新了合集，我暂时无法渲染，请自行查看</p> };
		case DYNAMIC_TYPE_NONE:
			return { vnode: <p>{upName}发布了一条无效动态</p> };
		case DYNAMIC_TYPE_LIVE_RCMD:
			throw new Error("直播开播动态，不做处理");
		default:
			return { vnode: <p>{upName}发布了一条我无法识别的动态，请自行查看</p> };
	}
}

// ── 私有辅助函数 ──────────────────────────────────────────────────────────────

function buildBasicContent(dynamic: Dynamic, isArticle: boolean, dirname: string) {
	const mod = dynamic.modules.module_dynamic;
	return (
		<>
			{mod?.desc?.rich_text_nodes && parseRichText(mod.desc.rich_text_nodes, undefined, isArticle)}
			{mod?.major?.opus?.summary?.rich_text_nodes &&
				parseRichText(mod.major.opus.summary.rich_text_nodes, mod.major.opus.title, isArticle)}
			{mod?.major?.opus?.pics && (
				<div class="mt-[8px]">{buildPicsContent(mod.major.opus.pics, dirname)}</div>
			)}
			{buildAdditionalContent(dynamic)}
		</>
	);
}

function buildPicsContent(
	pics: Array<{ height: number; url: string; width: number }>,
	dirname: string,
) {
	const arrowImg = pathToFileURL(resolve(dirname, "img/arrow.png")).toString();

	if (pics.length === 1) {
		const pic = pics[0];
		return (
			<div class="relative overflow-hidden rounded-lg" style="max-width: 600px;">
				<img class="w-full h-auto block" src={pic.url} alt="" />
				{pic.height > 3000 && (
					<>
						<div class="absolute bottom-0 left-0 right-0 h-[60px] bg-gradient-to-t from-black/50 to-transparent flex items-end p-2">
							<span class="text-white text-[12px]">点击链接浏览全部</span>
						</div>
						<img class="absolute right-2 bottom-2 w-5 h-5" src={arrowImg} alt="" />
					</>
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

function buildForwardBlock(
	avatarUrl: string,
	username: string,
	forwardLabel: string | undefined,
	content: VNode,
) {
	const label = forwardLabel ? ` ${forwardLabel}` : "";
	return (
		<div
			class="rounded-[8px] p-[10px] mt-2"
			style="background: rgba(0,0,0,0.04); border-left: 3px solid #00AEEC;"
		>
			<div class="flex items-center gap-[6px] mb-[6px]">
				<img
					class="w-[20px] h-[20px] rounded-full object-cover shrink-0"
					src={avatarUrl}
					alt="avatar"
				/>
				<span class="text-[13px] font-bold" style="color: #00AEEC;">
					{username}
					{label}
				</span>
			</div>
			<div class="text-[13px]" style="color: #444;">
				{content}
			</div>
		</div>
	);
}

function buildAdditionalContent(dynamic: Dynamic) {
	const additional = dynamic.modules.module_dynamic.additional;
	if (!additional) return null;
	let content: ReturnType<typeof buildReserveAdditional> | null = null;
	if (additional.type === ADDITIONAL_TYPE_RESERVE)
		content = buildReserveAdditional(additional.reserve);
	else if (additional.type === ADDITIONAL_TYPE_GOODS)
		content = buildGoodsAdditional(additional.goods);
	if (!content) return null;
	return <div class="mt-[8px]">{content}</div>;
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
				class={`shrink-0 px-3 py-1 rounded-[12px] text-[12px] ${
					isEnded
						? "border border-[#ccc] bg-[#f5f5f5] text-[#999]"
						: "border border-[#00AEEC] bg-white text-[#00AEEC]"
				}`}
			>
				{reserve.button.uncheck.text}
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
						<div class="shrink-0 px-[14px] py-[6px] rounded-[20px] bg-[#FF6699] text-white text-[12px] font-bold">
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
