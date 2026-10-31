import { parseCreator, publishedStamp } from "@bilibili-notify/ai";
import {
	type AiTool,
	type AiToolProvider,
	type AiToolResult,
	BILIBILI_SOURCE_KEY,
	type Failure,
	fail,
	type IntegrationContext,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { BILI_AI_TOOL_TEXTS } from "./ai-tool-texts.js";
import type { Api } from "./api/index.js";
import { BILI_EXTERNAL_ID_REGEX } from "./external-id.js";
import { BILI_WEEKLY_REPORT_SKILL } from "./weekly-report-skill.js";

type BiliAiApi = Pick<Api, "fetchUserUpstat" | "fetchUserNavnum" | "fetchUserVideos">;

const EXTERNAL_ID = new RegExp(BILI_EXTERNAL_ID_REGEX);

function failedWith(failure: Failure, prefix: (message: string) => string): Failure {
	return fail(failure.code, prefix(failure.message), {
		...(failure.upstreamCode === undefined ? {} : { upstreamCode: failure.upstreamCode }),
	});
}

function biliUidOf(args: Record<string, string>): string | Failure {
	const creator = args.creator?.trim() ?? "";
	const identity = parseCreator(creator);
	if (identity?.sourceKey !== BILIBILI_SOURCE_KEY || !EXTERNAL_ID.test(identity.externalId)) {
		return fail("invalid", BILI_AI_TOOL_TEXTS.invalidCreator(creator));
	}
	return identity.externalId;
}

function externalIdOf(creator: string): string {
	return parseCreator(creator)?.externalId ?? creator;
}

/**
 * B 站提交给宿主的只读 AI 工具。
 *
 * 工具本名由宿主加来源命名空间;两把都只收 B 站订阅的 creator,先从参数里核来源与
 * 外部 id,不合就在本地拒绝,避免拿别家恰好是数字的 id 去 B 站查到另一个人。
 */
export function createBiliAiToolProvider({
	api,
	context,
}: {
	api: BiliAiApi;
	context: Pick<IntegrationContext, "timezone">;
}): AiToolProvider {
	const totals: AiTool = {
		definition: {
			type: "function",
			function: {
				name: "get_up_totals",
				description: BILI_AI_TOOL_TEXTS.upTotalsDescription,
				parameters: {
					type: "object",
					properties: {
						creator: { type: "string", description: BILI_AI_TOOL_TEXTS.creatorParameter },
					},
					required: ["creator"],
				},
			},
		},
		get label() {
			return t("bilibili.aiTools.upTotals");
		},
		labelArg: { keys: ["creator"], format: externalIdOf },
		async execute(args): Promise<Result<AiToolResult>> {
			const uid = biliUidOf(args);
			if (typeof uid !== "string") return uid;
			const [upstat, navnum] = await Promise.all([
				api.fetchUserUpstat(uid),
				api.fetchUserNavnum(uid),
			]);
			if (!upstat.ok) return failedWith(upstat, BILI_AI_TOOL_TEXTS.dataFailed);
			// 此前不校验 navnum.code:接口错误时 navnum.data 为空 → 视频/动态数
			// 静默落 "?",把接口错误伪装成"数据空"误导 LLM。显式失败。
			if (!navnum.ok) return failedWith(navnum, BILI_AI_TOOL_TEXTS.dataFailed);
			const view = upstat.data.archive?.view ?? 0;
			const likes = upstat.data.likes ?? 0;
			const videos = navnum.data.video ?? "?";
			const dynamics = navnum.data.upos ?? "?";
			return ok({
				text: BILI_AI_TOOL_TEXTS.upTotals(view, likes, videos, dynamics),
			});
		},
	};

	const videos: AiTool = {
		definition: {
			type: "function",
			function: {
				name: "get_up_videos",
				description: BILI_AI_TOOL_TEXTS.upVideosDescription,
				parameters: {
					type: "object",
					properties: {
						creator: { type: "string", description: BILI_AI_TOOL_TEXTS.creatorParameter },
					},
					required: ["creator"],
				},
			},
		},
		get label() {
			return t("bilibili.aiTools.upVideos");
		},
		labelArg: { keys: ["creator"], format: externalIdOf },
		async execute(args): Promise<Result<AiToolResult>> {
			const uid = biliUidOf(args);
			if (typeof uid !== "string") return uid;
			const result = await api.fetchUserVideos(uid);
			if (!result.ok) return failedWith(result, BILI_AI_TOOL_TEXTS.videosFailed);
			const list = result.data.list?.vlist ?? [];
			if (list.length === 0) return ok({ text: BILI_AI_TOOL_TEXTS.noVideos });
			return ok({
				text: list
					.map((video, index) => {
						const created = typeof video.created === "number" ? video.created : undefined;
						return BILI_AI_TOOL_TEXTS.upVideo(
							index,
							publishedStamp(created, Date.now(), context.timezone()),
							video.title ?? "",
							video.play ?? "?",
						);
					})
					.join("\n"),
			});
		},
	};

	return { readOnly: [totals, videos], skills: [BILI_WEEKLY_REPORT_SKILL] };
}
