/**
 * 「模板变量可满足性」的运行时探针:每个渲染入口都用全表出现过的变量 + 一个 `{zzz}`
 * 调一次。表里这条点名的变量必须都被填掉,没点名的必须原样留着 —— 多填、少填都红。
 *
 * 这钉的是「表与实现不各说各话」:表里多写一个运行时不认的变量,或者运行时少交一个
 * 表里写着的变量,都会在这里红。反向断言「表里每条文案都有探针」负责提醒新文案补一行。
 */

import { buildMembershipCardView } from "@bilibili-notify/image";
import {
	DEFAULT_CONTENT_FILTERS,
	defaultMessageKindLayout,
	type ImageRef,
	type MessageLayoutSegment,
	ok,
	type PostEvent,
} from "@bilibili-notify/internal";
import { TEMPLATE_VARIABLES, type TemplateKey } from "@bilibili-notify/internal/template-variables";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderLiveSummary, renderLiveText } from "../live/live-text";
import { pushMembership } from "../live/membership";
import { pushViewerChat, pushViewerEnter } from "../live/special-viewers";
import { createCardFailureTracker, deliverPost, type PostSettings } from "../posts/deliver-post";
import type { PostPushAnchor } from "../posts/post-push";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * 全表出现过的变量名。探针模板把它们全拼上,再补一个 `{zzz}`:
 * 表里这一条点名的必须被填掉,表里没点名的必须原样留着 —— 运行时多填一个
 * (比如 `liveStart` 一直认 `{time}`,表里却漏了)也会红。
 */
const ALL_VARIABLE_NAMES = [
	...new Set(Object.values(TEMPLATE_VARIABLES).flatMap((entry) => Object.keys(entry))),
];

const PROBE_TEMPLATE = `${ALL_VARIABLE_NAMES.map((name) => `{${name}}`).join("|")}|{zzz}`;

function expectSatisfied(key: TemplateKey, text: string): void {
	const declared = new Set(Object.keys(TEMPLATE_VARIABLES[key]));
	for (const name of declared) {
		expect(text).not.toContain(`{${name}}`);
	}
	for (const name of ALL_VARIABLE_NAMES) {
		if (!declared.has(name)) expect(text).toContain(`{${name}}`);
	}
	expect(text).toContain("{zzz}");
}

const POST_SETTINGS: PostSettings = {
	filter: DEFAULT_CONTENT_FILTERS,
	messageLayout: defaultMessageKindLayout("post"),
	cardEnabled: false,
	aiEnabled: false,
	aiWebSearch: false,
	template: "",
	videoTemplate: "",
	imageGroup: { enabled: false, mergeForward: false },
};

function postEventOf(video: boolean): PostEvent {
	return {
		subscriptionId: "sub-1",
		identity: { sourceKey: "fake", externalId: "creator-1" },
		postId: "post-1",
		url: "https://example.com/post-1",
		post: {
			creator: { name: "阿绫" },
			publishedAt: "2026-10-19T00:00:00.000Z",
			text: "",
			...(video ? { video: { cover: {}, title: "视频", description: "说明" } } : {}),
		},
	};
}

async function deliveredPostText(video: boolean): Promise<string> {
	const anchors: PostPushAnchor[] = [];
	await deliverPost(postEventOf(video), {
		logger,
		settings: () => ({
			...POST_SETTINGS,
			template: PROBE_TEMPLATE,
			videoTemplate: PROBE_TEMPLATE,
		}),
		image: () => undefined,
		ai: () => undefined,
		cardFailures: createCardFailureTracker(),
		avatar: () => undefined,
		readImage: async () => undefined,
		push: async (_id, pushed) => {
			anchors.push(...pushed);
		},
		recordFiltered: vi.fn(),
		emitPipelineError: vi.fn(),
	});
	const main = anchors.find((anchor) => anchor.role === "main");
	if (main === undefined) return "";
	const messages = await main.messages;
	return (messages ?? [])
		.flat()
		.filter((segment): segment is Extract<MessageLayoutSegment, { kind: "text" }> => {
			return segment.kind === "text";
		})
		.map((segment) => segment.text)
		.join("");
}

async function membershipText(template: string): Promise<string> {
	const sent: Array<readonly MessageLayoutSegment[]> = [];
	await pushMembership(
		{
			event: {
				subscriptionId: "sub-1",
				viewer: { id: "viewer-1", name: "观众" },
				program: "guard",
				tier: { key: "captain", name: "舰长", rank: 1 },
			},
			tier: { key: "captain", name: "舰长", rank: 1 },
			minRank: undefined,
			template: {
				enabled: true,
				default: { template, imageUrl: "" },
				tiers: {},
			},
			creator: { name: "主播" },
			fallbackText: "",
		},
		{
			renderer: null,
			fetchTierIcon: async () => undefined,
			fetchViewerAvatar: async () => undefined,
			fetchImage: async () => ok({ ref: "unused" as ImageRef }),
			readImage: async () => undefined,
			send: async (segments) => {
				sent.push(segments);
			},
			logger,
		},
	);
	return (sent[0] ?? [])
		.filter((segment): segment is Extract<MessageLayoutSegment, { kind: "text" }> => {
			return segment.kind === "text";
		})
		.map((segment) => segment.text)
		.join("");
}

/** 表里每条文案 → 真跑一次渲染入口。新增一条文案却忘了补探针,下面那条反向断言会红。 */
const PROBES: Record<TemplateKey, () => string | Promise<string>> = {
	post: () => deliveredPostText(false),
	postVideo: () => deliveredPostText(true),
	liveStart: () =>
		renderLiveText("liveStart", PROBE_TEMPLATE, {
			name: "主播",
			time: "1:00",
			follower: 100,
		}),
	liveStreaming: () =>
		renderLiveText("liveStreaming", PROBE_TEMPLATE, {
			name: "主播",
			time: "1:00",
			watched: 10,
		}),
	liveEnd: () =>
		renderLiveText("liveEnd", PROBE_TEMPLATE, {
			name: "主播",
			time: "1:00",
			followerChange: 2,
		}),
	liveSummary: () =>
		renderLiveSummary({
			template: PROBE_TEMPLATE,
			senderCount: 3,
			fanClubName: "粉丝牌",
			viewerChatCount: 9,
			topSenders: [
				["甲", 1],
				["乙", 2],
				["丙", 3],
				["丁", 4],
				["戊", 5],
			],
		}),
	viewerChat: () => {
		let text = "";
		pushViewerChat(
			{
				viewer: { id: "viewer-1", name: "小明" },
				text: "你好",
				settings: {
					specialViewers: [{ id: "viewer-1", features: ["viewerChat"] }],
					template: PROBE_TEMPLATE,
				},
				creator: { name: "主播" },
			},
			{ send: (rendered) => (text = rendered) },
		);
		return text;
	},
	viewerEnter: () => {
		let text = "";
		pushViewerEnter(
			{
				viewer: { id: "viewer-1", name: "小明" },
				settings: {
					specialViewers: [{ id: "viewer-1", features: ["viewerEnter"] }],
					template: PROBE_TEMPLATE,
				},
				creator: { name: "主播" },
			},
			{ send: (rendered) => (text = rendered) },
		);
		return text;
	},
	membership: () => membershipText(PROBE_TEMPLATE),
	membershipAnnouncement: () =>
		buildMembershipCardView({
			viewer: { name: "观众" },
			creator: { name: "主播" },
			tier: {
				name: "舰长",
				announcement: PROBE_TEMPLATE,
			},
		}).announcement,
};

describe("每个渲染入口都交得起表里登记的全部变量", () => {
	it("表里每条文案都有探针", () => {
		expect(Object.keys(PROBES).sort()).toEqual(Object.keys(TEMPLATE_VARIABLES).sort());
	});

	it.each(Object.entries(PROBES))("%s", async (key, probe) => {
		expectSatisfied(key as TemplateKey, await probe());
	});
});
