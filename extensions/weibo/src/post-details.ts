import type { ExtensionContext, ExtensionPostReport } from "@bilibili-notify/extension";
import { communityId, plainText } from "./caption";
import { record } from "./client";
import { image, imageUrl } from "./media";

type Details = Pick<
	ExtensionPostReport["post"],
	"publicationInfo" | "topic" | "topicIcon" | "attachment"
>;

function headerCommunity(row: Record<string, unknown>) {
	const header = record(row.title_source);
	const url = typeof header.url === "string" ? URL.parse(header.url) : null;
	const id =
		url?.protocol === "sinaweibo:" && url.hostname === "pageinfo"
			? communityId(url.searchParams.get("pageid") ?? url.searchParams.get("containerid"))
			: undefined;
	const suffix = Array.isArray(row.screen_name_suffix_new)
		? row.screen_name_suffix_new.map(record)
		: [];
	const badge = suffix
		.flatMap((item) => (Array.isArray(item.icons) ? item.icons : []))
		.map(record)
		.find((item) => item.type === "chaohua");
	if (!id && !badge) return;
	return {
		id,
		name:
			(id && plainText(header.name)) || plainText(suffix.find((item) => item.type === 2)?.content),
		icon: imageUrl(badge?.url),
		cover: id ? imageUrl(header.image) : undefined,
	};
}

export async function postDetails(
	ctx: ExtensionContext,
	row: Record<string, unknown>,
	signal: AbortSignal,
): Promise<Details> {
	const details: Details = {};
	const device = plainText(row.source);
	const info = [device && ctx.i18n.t("post.via", { device }), plainText(row.region_name)]
		.filter(Boolean)
		.join(" · ");
	if (info) details.publicationInfo = info;

	const primary = headerCommunity(row);
	if (primary?.name) {
		details.topic = primary.name;
		details.topicIcon = (await image(ctx, primary.icon, signal)) ?? null;
	}
	const cards = Array.isArray(row.common_struct) ? row.common_struct.map(record) : [];
	const card = cards.find(
		(item) =>
			communityId(item.page_id) &&
			(!primary?.id || item.page_id === primary.id) &&
			plainText(item.name),
	);
	if (!card) return details;
	const cover = await image(
		ctx,
		imageUrl(card.img) ?? (card.page_id === primary?.id ? primary?.cover : undefined),
		signal,
	);
	const description = plainText(card.desc);
	const action = Array.isArray(card.buttons)
		? card.buttons.map(record).find((item) => item.type === "follow" && plainText(item.name))
		: undefined;
	details.attachment = {
		kind: "card",
		title: plainText(card.name),
		...(cover && { cover }),
		...(description && { lines: [{ text: description }] }),
		...(action && {
			button: {
				text: plainText(action.name),
				enabled: action.disabled !== true && action.disabled !== 1,
			},
		}),
	};
	return details;
}
