/**
 * 主人可改的文案 → 它能用的变量 → 变量取的中立字段。
 *
 * 纯数据模块,必须保持**零 import、零副作用**:面板经
 * `@bilibili-notify/internal/template-variables` 子路径直读它拼提示条,服务端的可满足性探针
 * 也从这里取变量名。表里只写中立类型上的字段路径(如 `Creator.name`),不写 B 站专有的
 * `uid` / 房号 / 档位键 —— 「模板变量只有 B 站填得出」这件事由表来挡。
 */

/** 一条变量的规格。`field` 是它取的中立字段路径(`类型.字段…`)。 */
export interface TemplateVariableSpec {
	field: string;
}

/**
 * 每条文案能用的变量。键就是 `{...}` 里的名字,`field` 写它从哪个中立字段来。
 *
 * `as const` 让每条文案推得出自己的变量名联合:面板的 `Record<变量名, 说明>` 与服务端探针
 * 都靠它,表里加一格而面板漏写说明会直接编译不过。
 */
export const TEMPLATE_VARIABLES = {
	post: {
		name: { field: "Post.creator.name" },
		postNoun: { field: "SourceDescriptor.postNoun" },
	},
	postVideo: {
		name: { field: "Post.creator.name" },
		postNoun: { field: "SourceDescriptor.postNoun" },
	},
	liveStart: {
		name: { field: "Creator.name" },
		// 场次已播时长从开播时刻起算,不是平台给的现成字符串。
		time: { field: "LiveSession.startedAt" },
		follower: { field: "CreatorProfile.followers" },
	},
	liveStreaming: {
		name: { field: "Creator.name" },
		time: { field: "LiveSession.startedAt" },
		watched: { field: "LiveDetails.totalViewers" },
	},
	liveEnd: {
		name: { field: "Creator.name" },
		time: { field: "LiveSession.startedAt" },
		follower_change: { field: "LiveSession.followersAtStart" },
	},
	liveSummary: {
		dmc: { field: "RecapSnapshot.senderCount" },
		fanclub: { field: "CreatorProfile.fanClubName" },
		dca: { field: "RecapSnapshot.viewerChatCount" },
		un1: { field: "RecapSnapshot.topSenders" },
		un2: { field: "RecapSnapshot.topSenders" },
		un3: { field: "RecapSnapshot.topSenders" },
		un4: { field: "RecapSnapshot.topSenders" },
		un5: { field: "RecapSnapshot.topSenders" },
		dc1: { field: "RecapSnapshot.topSenders" },
		dc2: { field: "RecapSnapshot.topSenders" },
		dc3: { field: "RecapSnapshot.topSenders" },
		dc4: { field: "RecapSnapshot.topSenders" },
		dc5: { field: "RecapSnapshot.topSenders" },
	},
	viewerChat: {
		name: { field: "Creator.name" },
		viewer: { field: "ViewerChatEvent.viewer.name" },
		msg: { field: "ViewerChatEvent.text" },
	},
	viewerEnter: {
		name: { field: "Creator.name" },
		viewer: { field: "ViewerEnterEvent.viewer.name" },
	},
	membership: {
		viewer: { field: "MembershipEvent.viewer.name" },
		name: { field: "Creator.name" },
		tier: { field: "MembershipEvent.tier.name" },
	},
	// 来源在档位表里交来的宣告语,也走同一个插值器;变量与自定义文案相同。
	membershipAnnouncement: {
		viewer: { field: "MembershipEvent.viewer.name" },
		name: { field: "Creator.name" },
		tier: { field: "MembershipTier.name" },
	},
} as const satisfies Record<string, Record<string, TemplateVariableSpec>>;

/** 表里点名的文案键。 */
export type TemplateKey = keyof typeof TEMPLATE_VARIABLES;
