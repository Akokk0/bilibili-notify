import { atAllOptsForDynamicKind, type PushKind, type PushLike } from "@bilibili-notify/dynamic";
import type { NotificationPayload, PayloadSegment } from "@bilibili-notify/internal";
import type { BilibiliPush } from "@bilibili-notify/push";

/**
 * Adapt the new BilibiliPush (platform-neutral) to the PushLike interface
 * that DynamicEngine expects. The engine sends PushSegment[] + PushKind;
 * this adapter translates to NotificationPayload and delegates to
 * push.broadcastToFeature.
 *
 * 抽成独立模块(不 import koishi 运行时)便于单测:adaptPush 仅依赖类型。
 */
export function adaptPush(push: BilibiliPush): PushLike {
	return {
		async broadcastDynamic(uid, segments, kind: PushKind) {
			let payload: NotificationPayload;
			if (segments.length === 1 && segments[0].type === "text") {
				payload = { kind: "text", text: segments[0].text };
			} else if (segments.length === 1 && segments[0].type === "image") {
				payload = {
					kind: "image",
					image: { buffer: segments[0].buffer, mime: segments[0].mime },
				};
			} else if (segments.length === 1 && segments[0].type === "image-group") {
				// 走 NotificationSink 的 forward-images 路径 —— sink 内部按 payload.forward
				// 决定走 koishi 合并转发(h("message", {forward:true}, nodes))还是普通
				// 多图(h("message", urls.map(h.image)))。forward 由 dynamic engine config
				// imageGroup.forward 控制(可 per-UP override sub.overrides.imageGroup.forward)。
				payload = {
					kind: "forward-images",
					images: segments[0].images,
					forward: segments[0].forward,
				};
			} else {
				// composite: map all segments
				const mapped: PayloadSegment[] = [];
				for (const seg of segments) {
					if (seg.type === "text") {
						mapped.push({ type: "text" as const, text: seg.text });
					} else if (seg.type === "image") {
						mapped.push({ type: "image" as const, buffer: seg.buffer, mime: seg.mime });
					} else {
						// image-group → individual links
						for (const img of seg.images) {
							mapped.push({ type: "link" as const, href: img.url });
						}
					}
				}
				payload = { kind: "composite", segments: mapped };
			}
			// kind="dynamic-images"(图集附图)是主卡片之后的附属推送,显式抑制 @全体 ——
			// 否则一条 DRAW 动态会在主卡片和图集各 @ 一次(用户报告的「重复艾特全体」)。
			await push.broadcastToFeature(uid, "dynamic", payload, atAllOptsForDynamicKind(kind));
		},
		sendPrivateMsg(content) {
			return push.sendPrivateMsg(content);
		},
		sendErrorMsg(reason) {
			return push.sendErrorMsg(reason);
		},
	};
}
