/** @jsxImportSource vue */

/**
 * 附加块(`Post.attachment`)→ VNode(㉑c 第 5 步)。
 *
 * 出图器按种类直接画封闭联合的三种:`card`(预约卡 / 通用卡)、`goods`(商品)、`video`(引用的视频)。
 * 返回内层 VNode(无外边距 —— 间距由 additional 版式块的 marginTop 控制)。
 *
 * **只画形状装得下的**(ADR-0021 决策 22 的 2026-10-05 🔗,主人定「不加字段,形状装不下的就不画」):
 * 文字行是 `card.lines`,每行只有 `{ text, icon? }`,各占一行、同一个样式({@link cardLines});按钮只有文字与可用 /
 * 不可用两态;商品没有按钮与价格后缀;视频卡没有标题上方的说明。图标要到 3a 才有图库引用可给,目前不画。
 *
 * **`card` 的两种版式由有没有 `cover` 选**:有封面是通用卡的排法(头部说明 + 封面 + 标题与文字行 + 按钮),
 * 没有封面是预约卡的排法(标题与文字行在左、按钮在右)。两种版式的字号、间距并不统一 —— 那不是形状逼的,
 * 先保持原样不动,统一留给 ㉔。
 */

import { type Attachment, formatClock } from "@bilibili-notify/internal";
import type { VNode } from "vue";

/**
 * `card` 的文字行:每行同一个样式、各占一行,行与行之间留 2px、最后一行不留。
 * 形状里 `lines` 每行只有 `{ text, icon? }`,没有同行并排、没有单行变色的位置。
 */
function cardLines(lines: readonly string[]) {
	return lines.map((line, i) => (
		<div
			key={i}
			class={`text-[12px] text-[#999] truncate${i < lines.length - 1 ? " mb-[2px]" : ""}`}
		>
			{line}
		</div>
	));
}

/**
 * `eyebrow`:卡上方的一行说明(商品卡与通用卡共用)。没有字就不画 —— 形状里 `eyebrow?` 缺席与空串
 * 是同一回事,来源给了空串也不留一条空行。
 */
function cardEyebrow(text: string | undefined) {
	return text ? (
		<div class="flex items-center gap-1 text-[12px] text-[#999] mb-[6px]">{text}</div>
	) : null;
}

type Card = Extract<Attachment, { kind: "card" }>;
type Goods = Extract<Attachment, { kind: "goods" }>;
type VideoAttachment = Extract<Attachment, { kind: "video" }>;

const textsOf = (card: Card): string[] => (card.lines ?? []).map((line) => line.text);

/** 有封面的卡:头部说明、封面、标题与文字行、按钮(通用卡的排法)。 */
function coverCard(card: Card & { cover: NonNullable<Card["cover"]> }): VNode {
	return (
		<div>
			{cardEyebrow(card.eyebrow)}
			<div data-bn="card" class="bg-black/4 rounded-lg p-[10px]">
				<div class="flex gap-[10px] items-center">
					<div class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden">
						<img data-bn="cover" class="w-full h-full object-cover" src={card.cover.url} alt="" />
					</div>
					<div class="flex-1 min-w-0">
						<div class="text-[13px] font-bold text-[#18191C] mb-[4px]">{card.title}</div>
						{cardLines(textsOf(card))}
					</div>
					{card.button ? (
						<div
							data-bn="button"
							class={`shrink-0 px-[14px] py-[6px] rounded-[6px] ${
								card.button.enabled ? "bg-[#FB7299] text-white" : "bg-[#f5f5f5] text-[#999]"
							} text-[12px] font-bold leading-none`}
						>
							{card.button.text}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

/** 没有封面的卡:标题与文字行在左、按钮在右(预约卡的排法)。 */
function plainCard(card: Card): VNode {
	const box = (
		<div
			data-bn="card"
			class="flex justify-between items-center gap-[10px] bg-black/4 rounded-lg p-[10px]"
		>
			<div class="flex-1 min-w-0">
				<div class="text-[14px] font-bold text-[#18191C] mb-1">{card.title}</div>
				{cardLines(textsOf(card))}
			</div>
			{card.button ? (
				<div
					data-bn="button"
					class={`shrink-0 px-3 py-[6px] rounded-[6px] text-[12px] font-bold leading-none ${
						card.button.enabled ? "bg-[#FB7299] text-white" : "bg-[#f5f5f5] text-[#999]"
					}`}
				>
					{card.button.text}
				</div>
			) : null}
		</div>
	);
	// 预约卡没有头部说明;真有就叠在上面,与通用卡同一个样子。
	return card.eyebrow ? (
		<div>
			{cardEyebrow(card.eyebrow)}
			{box}
		</div>
	) : (
		box
	);
}

/** 商品:单件画封面、名字与价格,多件只画封面。 */
function goodsCard(goods: Goods): VNode {
	const isSingle = goods.items.length === 1;
	const first = goods.items[0];
	return (
		<div>
			{cardEyebrow(goods.eyebrow)}
			<div data-bn="card" class="bg-black/4 rounded-lg p-[10px]">
				{isSingle && first ? (
					<div class="flex gap-[10px] items-center">
						<div class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden">
							<img
								data-bn="cover"
								class="w-full h-full object-cover"
								src={first.cover.url}
								alt=""
							/>
						</div>
						<div class="flex-1 min-w-0">
							<div class="text-[13px] text-[#18191C] line-clamp-2 mb-[6px]">{first.name}</div>
							{first.price && <div class="text-[14px] text-[#FF6699] font-bold">{first.price}</div>}
						</div>
					</div>
				) : (
					<div class="flex gap-[8px] flex-wrap">
						{goods.items.map((item, i) => (
							<div key={i} class="w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden bg-black/8">
								<img
									data-bn="cover"
									class="w-full h-full object-cover"
									src={item.cover.url}
									alt=""
								/>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * 引用的视频:封面 + 时长角标 + 标题 + `subtitle`。`subtitle` 是来源拼好的整句(「2654观看 102弹幕」),
 * 官方页面也是当纯文本灰字渲染的,别再套图标重排。
 */
function videoCard(video: VideoAttachment): VNode {
	const duration = video.durationSec === undefined ? undefined : formatClock(video.durationSec);
	return (
		<div data-bn="card" class="bg-black/4 rounded-lg p-[10px]">
			<div class="flex gap-[10px] items-center">
				<div class="relative w-[140px] h-[80px] shrink-0 rounded-md overflow-hidden bg-black/8">
					<img
						data-bn="cover"
						class="w-full h-full object-cover block"
						src={video.cover.url}
						alt=""
					/>
					{/*
					 * 角标衬一层深色底,不是只给文字加 text-shadow —— 封面右下角是什么颜色
					 * 完全由 UP 决定,遇上亮底(放射光、白背景)白字加弱阴影就糊没了。
					 * 主视频卡靠整张压暗 bg-black/20 兜住,这里封面小、压暗会让整卡发灰,
					 * 改成只在角标下垫一块。
					 */}
					{duration && (
						<span class="absolute bottom-[4px] right-[4px] px-[4px] py-[1px] rounded-[3px] bg-black/60 text-white text-[11px] font-bold leading-[1.4]">
							{duration}
						</span>
					)}
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-[13px] font-bold text-[#18191C] line-clamp-2 mb-[6px]">
						{video.title}
					</div>
					{video.subtitle && <div class="text-[12px] text-[#999] truncate">{video.subtitle}</div>}
				</div>
			</div>
		</div>
	);
}

/** 一个附加块画成什么样。 */
export function attachmentNode(attachment: Attachment): VNode {
	switch (attachment.kind) {
		case "card":
			return attachment.cover
				? coverCard({ ...attachment, cover: attachment.cover })
				: plainCard(attachment);
		case "goods":
			return goodsCard(attachment);
		case "video":
			return videoCard(attachment);
	}
}
