import type { MaidSkill } from "@bilibili-notify/internal";

/** B 站版周报:B 站独有的数据(总播放、获赞、视频列表)只在这条提供方技能里用;宿主登记后它叫 `bilibili-weekly-report`。 */
export const BILI_WEEKLY_REPORT_SKILL: MaidSkill = {
	name: "weekly-report",
	description:
		"B 站版周报:把所有订阅的 UP 拉一遍数据,评出本周最勤奋与最能鸽的那几位,出一张榜再锐评几句",
	allowedTools: [
		"list_subscriptions",
		"bilibili__get_up_totals",
		"bilibili__get_up_videos",
		"get_creator_posts",
		"get_creator_profile",
	],
	disableModelInvocation: false,
	body: [
		"## 周报",
		"",
		"### 步骤",
		"",
		"1. `list_subscriptions` 拿到全部订阅。**一个都不要漏**,也不要只挑几个有名的看。",
		"2. 对每一位 UP 调 `bilibili__get_up_totals`(总播放 / 总获赞 / 视频数 / 动态数),再调 `bilibili__get_up_videos` 看最近发了什么、什么时候发的;两把都传这位的 `creator`;订了动态、没订直播的那几位,再调 `get_creator_posts` 看最近一条动态是什么时候(下面判鸽王要用)。",
		"3. 订阅超过 12 位时,先用 `bilibili__get_up_totals` 过一遍,只对**数据最活跃的前 8 位**和**最沉寂的 3 位**再拉 `bilibili__get_up_videos` —— 中间那段既不上榜也不进鸽王名单,拉了也用不上。这一步省下的是主人的等待时间。",
		"",
		"### 判定",
		"",
		"- **勤奋**:看的是这一周真的产出了多少,不是历史总量。一个总播放很高但半个月没动静的人不算勤奋。",
		"- **鸽王**:最近一条视频距今越久越靠前。只订了动态没订直播的 UP,拿动态当产出算,别按视频判他鸽。",
		"- 手上的数据支撑不了某个结论时,**就说数据不够**,不要靠印象补。",
		"",
		"### 输出",
		"",
		"先出一张 Markdown 表格:`UP 主 | 本周产出 | 最近一条 | 一句话`。",
		"表格之后,挑最勤奋和最能鸽的各一位,各锐评两三句 —— 毒舌可以,但**每句都得挂在刚才查到的数据上**,不许凭空编排。",
	].join("\n"),
};
