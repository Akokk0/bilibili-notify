/**
 * 把一条视频信息拼成「投稿了视频」形态的动态,喂给现有的动态卡渲染器。
 *
 * 不新做视频卡:动态卡的版式编辑器、每类型样式、皮肤全都现成,拼一条动态就全拿到。
 * 字段照 B 站 `DYNAMIC_TYPE_AV` 抓包的样子摆 —— 模板只认那几个键。
 */

import type { VideoInfo } from "@bilibili-notify/api";
import type { Dynamic } from "@bilibili-notify/image";

/** 与渲染器 `numberToStr` 同一套规矩:万 / 亿,一位小数。 */
export function formatCount(n: number): string {
	if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
	if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
	return String(n);
}

/** 秒 → `m:ss` / `h:mm:ss`,与 B 站封面角标一致。 */
export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function videoToDynamic(info: VideoInfo): Dynamic {
	return {
		basic: {},
		id_str: `video:${info.bvid}`,
		type: "DYNAMIC_TYPE_AV",
		visible: true,
		modules: {
			module_author: {
				avatar: {},
				face: info.owner.face,
				face_nft: false,
				following: false,
				jump_url: `//space.bilibili.com/${info.owner.mid}`,
				label: "",
				mid: info.owner.mid,
				name: info.owner.name,
				pub_action: "投稿了视频",
				pub_action_text: "",
				pub_location_text: "",
				pub_time: "",
				pub_ts: info.pubdate,
				type: "AUTHOR_TYPE_NORMAL",
				vip: { type: 0 },
			},
			module_dynamic: {
				major: {
					type: "MAJOR_TYPE_ARCHIVE",
					archive: {
						badge: { text: "投稿视频" },
						cover: info.pic,
						duration_text: formatDuration(info.duration),
						title: info.title,
						desc: info.desc,
						stat: { play: formatCount(info.stat.view), danmaku: formatCount(info.stat.danmaku) },
						bvid: info.bvid,
						jump_url: `//www.bilibili.com/video/${info.bvid}`,
					},
				},
			},
			module_stat: {
				comment: { count: info.stat.reply },
				forward: { count: info.stat.share },
				like: { count: info.stat.like },
			},
		},
	};
}
