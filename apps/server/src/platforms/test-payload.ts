import type {
	NotificationPayload,
	PlatformTestOptions,
	Result,
	SendTestKind,
} from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";

/** 内置适配器共用的真实样例，平台特有的分享预设与作用域检查由各适配器处理。 */
export function commonTestPayload(
	kind: SendTestKind,
	samples: PlatformTestOptions,
): Result<{ payload: NotificationPayload }> {
	switch (kind) {
		case "text":
			return ok<{ payload: NotificationPayload }>({
				payload: { kind: "text", text: samples.text },
			});
		case "atAll":
			return ok<{ payload: NotificationPayload }>({
				payload: {
					kind: "composite",
					segments: [{ kind: "at-all" }, { kind: "text", text: samples.text }],
				},
			});
		case "image":
			return ok<{ payload: NotificationPayload }>({
				payload: { kind: "image", image: samples.image, caption: samples.text },
			});
		case "imageGroup":
			return ok<{ payload: NotificationPayload }>({
				payload: {
					kind: "composite",
					segments: [
						{ kind: "image", ...samples.image },
						{ kind: "image", ...samples.secondImage },
					],
				},
			});
		case "audio":
			return ok<{ payload: NotificationPayload }>({
				payload: { kind: "audio", audio: samples.audio },
			});
		case "markdown":
			return ok<{ payload: NotificationPayload }>({
				payload: { kind: "markdown", text: `# BN\n\n**${samples.text}**\n\n- BN` },
			});
		case "forward":
		case "nativeShare":
			return fail("unsupported", t("capabilityTests.noSample"));
	}
}
