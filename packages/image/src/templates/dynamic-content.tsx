/** @jsxImportSource vue */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VNode } from "vue";
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

// ── SVG 图标常量 ──────────────────────────────────────────────────────────────

const SVG_VIEW = (
	<svg
		style="width:14px;height:14px;flex-shrink:0"
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 20 20"
		aria-label="播放量"
	>
		<path
			d="M10 4.040041666666666C7.897383333333334 4.040041666666666 6.061606666666667 4.147 4.765636666666667 4.252088333333334C3.806826666666667 4.32984 3.061106666666667 5.0637316666666665 2.9755000000000003 6.015921666666667C2.8803183333333333 7.074671666666667 2.791666666666667 8.471183333333332 2.791666666666667 9.998333333333333C2.791666666666667 11.525566666666668 2.8803183333333333 12.922083333333333 2.9755000000000003 13.9808C3.061106666666667 14.932983333333334 3.806826666666667 15.666916666666667 4.765636666666667 15.744683333333336C6.061611666666668 15.849716666666666 7.897383333333334 15.956666666666667 10 15.956666666666667C12.10285 15.956666666666667 13.93871666666667 15.849716666666666 15.234766666666667 15.74461666666667C16.193416666666668 15.66685 16.939000000000004 14.933216666666667 17.024583333333336 13.981216666666668C17.11975 12.922916666666667 17.208333333333332 11.526666666666666 17.208333333333332 9.998333333333333C17.208333333333332 8.470083333333333 17.11975 7.073818333333334 17.024583333333336 6.015513333333334C16.939000000000004 5.063538333333333 16.193416666666668 4.329865000000001 15.234766666666667 4.252118333333334C13.93871666666667 4.147016666666667 12.10285 4.040041666666666 10 4.040041666666666zM4.684808333333334 3.255365C6.001155 3.14862 7.864583333333334 3.0400416666666668 10 3.0400416666666668C12.13565 3.0400416666666668 13.999199999999998 3.148636666666667 15.315566666666667 3.2553900000000002C16.753416666666666 3.3720016666666672 17.890833333333333 4.483195 18.020583333333335 5.925965000000001C18.11766666666667 7.005906666666667 18.208333333333336 8.433 18.208333333333336 9.998333333333333C18.208333333333336 11.56375 18.11766666666667 12.990833333333335 18.020583333333335 14.0708C17.890833333333333 15.513533333333331 16.753416666666666 16.624733333333335 15.315566666666667 16.74138333333333C13.999199999999998 16.848116666666666 12.13565 16.95666666666667 10 16.95666666666667C7.864583333333334 16.95666666666667 6.001155 16.848116666666666 4.684808333333334 16.7414C3.2467266666666665 16.624750000000002 2.1092383333333338 15.513266666666667 1.9795200000000002 14.070383333333334C1.8823900000000002 12.990000000000002 1.7916666666666667 11.562683333333334 1.7916666666666667 9.998333333333333C1.7916666666666667 8.434066666666666 1.8823900000000002 7.00672 1.9795200000000002 5.926381666666667C2.1092383333333338 4.483463333333334 3.2467266666666665 3.371976666666667 4.684808333333334 3.255365z"
			fill="currentColor"
		/>
		<path
			d="M12.23275 9.1962C12.851516666666667 9.553483333333332 12.851516666666667 10.44665 12.232683333333332 10.803866666666666L9.57975 12.335600000000001C8.960983333333335 12.692816666666667 8.1875 12.246250000000002 8.187503333333334 11.531733333333333L8.187503333333334 8.4684C8.187503333333334 7.753871666666667 8.960983333333335 7.307296666666667 9.57975 7.66456L12.23275 9.1962z"
			fill="currentColor"
		/>
	</svg>
);

const SVG_DANMAKU = (
	<svg
		style="width:14px;height:14px;flex-shrink:0"
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 20 20"
		aria-label="弹幕"
	>
		<path
			d="M10 4.040041666666666C7.897383333333334 4.040041666666666 6.061606666666667 4.147 4.765636666666667 4.252088333333334C3.806826666666667 4.32984 3.061106666666667 5.0637316666666665 2.9755000000000003 6.015921666666667C2.8803183333333333 7.074671666666667 2.791666666666667 8.471183333333332 2.791666666666667 9.998333333333333C2.791666666666667 11.525566666666668 2.8803183333333333 12.922083333333333 2.9755000000000003 13.9808C3.061106666666667 14.932983333333334 3.806826666666667 15.666916666666667 4.765636666666667 15.744683333333336C6.061611666666668 15.849716666666666 7.897383333333334 15.956666666666667 10 15.956666666666667C12.10285 15.956666666666667 13.93871666666667 15.849716666666666 15.234766666666667 15.74461666666667C16.193416666666668 15.66685 16.939000000000004 14.933216666666667 17.024583333333336 13.981216666666668C17.11975 12.922916666666667 17.208333333333332 11.526666666666666 17.208333333333332 9.998333333333333C17.208333333333332 8.470083333333333 17.11975 7.073818333333334 17.024583333333336 6.015513333333334C16.939000000000004 5.063538333333333 16.193416666666668 4.329865000000001 15.234766666666667 4.252118333333334C13.93871666666667 4.147016666666667 12.10285 4.040041666666666 10 4.040041666666666zM4.684808333333334 3.255365C6.001155 3.14862 7.864583333333334 3.0400416666666668 10 3.0400416666666668C12.13565 3.0400416666666668 13.999199999999998 3.148636666666667 15.315566666666667 3.2553900000000002C16.753416666666666 3.3720016666666672 17.890833333333333 4.483195 18.020583333333335 5.925965000000001C18.11766666666667 7.005906666666667 18.208333333333336 8.433 18.208333333333336 9.998333333333333C18.208333333333336 11.56375 18.11766666666667 12.990833333333335 18.020583333333335 14.0708C17.890833333333333 15.513533333333331 16.753416666666666 16.624733333333335 15.315566666666667 16.74138333333333C13.999199999999998 16.848116666666666 12.13565 16.95666666666667 10 16.95666666666667C7.864583333333334 16.95666666666667 6.001155 16.848116666666666 4.684808333333334 16.7414C3.2467266666666665 16.624750000000002 2.1092383333333338 15.513266666666667 1.9795200000000002 14.070383333333334C1.8823900000000002 12.990000000000002 1.7916666666666667 11.562683333333334 1.7916666666666667 9.998333333333333C1.7916666666666667 8.434066666666666 1.8823900000000002 7.00672 1.9795200000000002 5.926381666666667C2.1092383333333338 4.483463333333334 3.2467266666666665 3.371976666666667 4.684808333333334 3.255365z"
			fill="currentColor"
		/>
		<path
			d="M13.291666666666666 8.833333333333334L8.166666666666668 8.833333333333334C7.890526666666666 8.833333333333334 7.666666666666666 8.609449999999999 7.666666666666666 8.333333333333334C7.666666666666666 8.057193333333334 7.890526666666666 7.833333333333334 8.166666666666668 7.833333333333334L13.291666666666666 7.833333333333334C13.567783333333335 7.833333333333334 13.791666666666668 8.057193333333334 13.791666666666668 8.333333333333334C13.791666666666668 8.609449999999999 13.567783333333335 8.833333333333334 13.291666666666666 8.833333333333334z"
			fill="currentColor"
		/>
		<path
			d="M14.541666666666666 12.166666666666666L9.416666666666668 12.166666666666666C9.140550000000001 12.166666666666666 8.916666666666666 11.942783333333333 8.916666666666666 11.666666666666668C8.916666666666666 11.390550000000001 9.140550000000001 11.166666666666668 9.416666666666668 11.166666666666668L14.541666666666666 11.166666666666668C14.817783333333335 11.166666666666668 15.041666666666668 11.390550000000001 15.041666666666668 11.666666666666668C15.041666666666668 11.942783333333333 14.817783333333335 12.166666666666666 14.541666666666666 12.166666666666666z"
			fill="currentColor"
		/>
		<path
			d="M6.5 8.333333333333334C6.5 8.609449999999999 6.27614 8.833333333333334 6 8.833333333333334L5.458333333333333 8.833333333333334C5.182193333333334 8.833333333333334 4.958333333333334 8.609449999999999 4.958333333333334 8.333333333333334C4.958333333333334 8.057193333333334 5.182193333333334 7.833333333333334 5.458333333333333 7.833333333333334L6 7.833333333333334C6.27614 7.833333333333334 6.5 8.057193333333334 6.5 8.333333333333334z"
			fill="currentColor"
		/>
		<path
			d="M7.750000000000001 11.666666666666668C7.750000000000001 11.942783333333333 7.526140000000001 12.166666666666666 7.25 12.166666666666666L6.708333333333334 12.166666666666666C6.432193333333334 12.166666666666666 6.208333333333334 11.942783333333333 6.208333333333334 11.666666666666668C6.208333333333334 11.390550000000001 6.432193333333334 11.166666666666668 6.708333333333334 11.166666666666668L7.25 11.166666666666668C7.526140000000001 11.166666666666668 7.750000000000001 11.390550000000001 7.750000000000001 11.666666666666668z"
			fill="currentColor"
		/>
	</svg>
);

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
			{mod?.major?.opus?.pics && buildPicsContent(mod.major.opus.pics, dirname)}
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
	const imgClass = is2col
		? "w-[calc(50%-4px)] aspect-square"
		: "w-[calc(33.33%-6px)] aspect-square";
	return (
		<div class="flex flex-wrap gap-[8px]" style="max-width: 600px;">
			{pics.map((p, i) => (
				<img key={i} class={`${imgClass} object-cover rounded shrink-0`} src={p.url} alt="" />
			))}
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
	if (additional.type === ADDITIONAL_TYPE_RESERVE)
		return buildReserveAdditional(additional.reserve);
	if (additional.type === ADDITIONAL_TYPE_GOODS) return buildGoodsAdditional(additional.goods);
	return null;
}

// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回的预约数据类型不固定
function buildReserveAdditional(reserve: any) {
	const isEnded = reserve.button.uncheck.text === "已结束";
	return (
		<div class="flex justify-between items-center gap-[10px] bg-black/4 rounded-lg p-[10px] mt-1">
			<div class="flex-1 min-w-0">
				<div class="text-[14px] font-bold text-[#18191C] mb-1">{reserve.title}</div>
				<div class="flex gap-2 text-[12px] text-[#999]">
					<span>{reserve.desc1.text}</span>
					<span>{reserve.desc2.text}</span>
				</div>
				{reserve.desc3 && (
					<div class="flex items-center gap-1 text-[12px] text-[#FF6699] mt-1">
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
	return (
		<div class="mt-1">
			<div class="flex items-center gap-1 text-[12px] text-[#999] mb-[6px]">{goods.head_text}</div>
			<div class="bg-black/4 rounded-lg p-[10px]">
				{goods.items.length === 1 ? (
					<div class="flex gap-[10px] items-center">
						<div class="w-20 h-20 shrink-0 rounded-md overflow-hidden">
							<img class="w-full h-full object-cover" src={goods.items[0].cover} alt="" />
						</div>
						<div class="flex-1 min-w-0">
							<div class="text-[14px] text-[#18191C] mb-[6px] line-clamp-2">
								{goods.items[0].name}
							</div>
							<div class="text-[16px] text-[#FF6699] font-bold">{goods.items[0].price}</div>
						</div>
					</div>
				) : (
					// biome-ignore lint/suspicious/noExplicitAny: Bilibili goods API returns untyped items
					goods.items.slice(0, 3).map((item: any, i: number) => (
						<div key={i} class="flex gap-2 items-center mb-2">
							<div class="w-[50px] h-[50px] shrink-0 rounded overflow-hidden">
								<img class="w-full h-full object-cover" src={item.cover} alt="" />
							</div>
							<div class="flex-1 min-w-0 text-[12px] text-[#18191C] line-clamp-1">{item.name}</div>
						</div>
					))
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
