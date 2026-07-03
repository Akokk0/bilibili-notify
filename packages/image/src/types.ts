export type Dynamic = {
	/**
	 * `is_only_fans` = 该动态是充电专属内容。未充电用户拉取时接口会把整个
	 * `module_dynamic` 清空(desc/major/topic/additional 全 null)—— `buildDynamicNode`
	 * 据此渲染占位提示,而非空白正文(见 dynamic-content.tsx)。
	 */
	basic: { is_only_fans?: boolean } & Record<string, unknown>;
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
			/** 充电专属徽标(仅该 UP 开通充电计划的动态可能带);缺省时占位提示用固定文案兜底。 */
			icon_badge?: { text: string; icon?: string };
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
	watchedNum?: string | number;
	likedNum?: string | number;
	fansNum?: string | number;
	fansChanged?: string | number;
};

export type CardColorOptions = {
	cardColorStart?: string;
	cardColorEnd?: string;
	/** 玻璃片(内容层)透明度 0..1;缺省时各卡走自身基线。 */
	glassOpacity?: number;
	/** 完全透明:内容层透明 + 无模糊(优先于 glassOpacity)。 */
	glassClear?: boolean;
	/** 自定义背景图资产 id(或已解析 URL);缺省时走渐变。 */
	backgroundImage?: string;
	/** 直播卡数据区:显示人气 / 点赞;缺省时回退渲染器全局 config。 */
	showPopularity?: boolean;
	/** 直播卡数据区:显示分区;缺省时回退渲染器全局 config。 */
	showArea?: boolean;
	/** 直播卡数据区:显示粉丝数据;缺省时回退渲染器全局 config。 */
	showFans?: boolean;
};
