export type Dynamic = {
	basic: object;
	id_str: string;
	modules: {
		module_author: {
			avatar: object;
			decorate?: {
				card_url: string;
				fan: { num_str: number; color: string };
			};
			face: string;
			face_nft: boolean;
			following: boolean;
			jump_url: string;
			label: string;
			mid: number;
			name: string;
			pub_action: string;
			pub_action_text: string;
			pub_location_text: string;
			pub_time: string;
			pub_ts: number;
			type: string;
			vip: { type: number };
		};
		module_dynamic: {
			// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回多样化的 additional 类型
			additional?: any;
			desc?: {
				rich_text_nodes: RichTextNode;
				text: string;
			};
			major?: {
				opus?: {
					fold_action: string[];
					jump_url: string;
					pics?: Array<{
						height: number;
						url: string;
						width: number;
						size: number;
						live_url: string;
					}>;
					summary?: { rich_text_nodes: RichTextNode; text: string };
					title?: string;
				};
				archive?: {
					badge: { text: string };
					cover: string;
					duration_text: string;
					title: string;
					desc: string;
					stat: { play: number; danmaku: number };
					bvid: string;
					jump_url: string;
				};
				// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回多样化的 draw 类型
				draw?: any;
				type: string;
			};
			// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回多样化的 topic 类型
			topic?: any;
		};
		module_stat: {
			comment: { count: number };
			forward: { count: number };
			like: { count: number };
		};
	};
	orig?: Dynamic;
	type: string;
	visible: boolean;
};

export type RichTextNode = Array<{
	emoji?: { icon_url: string; size: number; text: string; type: number };
	orig_text: string;
	text: string;
	type: string;
}>;

export type LiveData = {
	watchedNum?: string;
	likedNum?: string;
	fansNum?: string;
	fansChanged?: string;
};

export type CardColorOptions = {
	cardColorStart?: string;
	cardColorEnd?: string;
	cardBasePlateColor?: string;
	cardBasePlateBorder?: string;
};
