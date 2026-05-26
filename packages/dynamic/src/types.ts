// ---- Dynamic API response types ----

export type RichTextNode = {
	orig_text: string;
	text: string;
	type: string;
	emoji?: { icon_url: string; size: number; text: string; type: number };
	jump_url?: string;
	rid?: string;
	// biome-ignore lint/suspicious/noExplicitAny: API response
	goods?: any;
	icon_name?: string;
};

export type Dynamic = {
	// biome-ignore lint/complexity/noBannedTypes: API response shape
	basic: Object;
	id_str: string;
	type: string;
	orig?: Dynamic;
	modules: {
		module_author: {
			face: string;
			following: boolean;
			jump_url: string;
			label: string;
			mid: number;
			name: string;
			pub_action: string;
			pub_time: string;
			pub_ts: number;
			type: string;
			// biome-ignore lint/suspicious/noExplicitAny: API response
			[key: string]: any;
		};
		module_dynamic: {
			// biome-ignore lint/suspicious/noExplicitAny: API response
			additional?: any;
			desc?: {
				rich_text_nodes: RichTextNode[];
				text: string;
			};
			major?: {
				opus?: {
					fold_action: string[];
					jump_url: string;
					pics: Array<{
						height: number;
						live_url: string;
						size: number;
						url: string;
						width: number;
					}>;
					summary: {
						rich_text_nodes: RichTextNode[];
						text: string;
					};
					title: string;
				};
				archive?: {
					title: string;
					jump_url: string;
					// biome-ignore lint/suspicious/noExplicitAny: API response
					[key: string]: any;
				};
				// biome-ignore lint/suspicious/noExplicitAny: API response
				[key: string]: any;
			};
		};
	};
};

export type AllDynamicInfo = {
	code: number;
	message: string;
	data: {
		has_more: boolean;
		items: Dynamic[];
		offset: string;
		update_baseline: string;
		update_num: number;
	};
};

export type DynamicTimelineManager = Map<string, number>;

// ---- Filter types ----

export interface DynamicFilterConfig {
	enable?: boolean;
	notify?: boolean;
	regex?: string;
	keywords?: string[];
	forward?: boolean;
	article?: boolean;
	/** DYNAMIC_TYPE_DRAW(图文动态;新版 B 站把图文挂在 major.opus 下,外层 type 仍为 DRAW)。 */
	draw?: boolean;
	/** DYNAMIC_TYPE_AV(视频投稿动态)。 */
	av?: boolean;
	whitelistEnable?: boolean;
	whitelistRegex?: string;
	whitelistKeywords?: string[];
}

export enum DynamicFilterReason {
	BlacklistKeyword = "blacklist-keyword",
	BlacklistForward = "blacklist-forward",
	BlacklistArticle = "blacklist-article",
	BlacklistDraw = "blacklist-draw",
	BlacklistAv = "blacklist-av",
	WhitelistUnmatched = "whitelist-unmatched",
}

export interface DynamicFilterResult {
	blocked: boolean;
	reason?: DynamicFilterReason;
}
