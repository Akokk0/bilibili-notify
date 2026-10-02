/**
 * 把一条视频信息拼成「投稿了视频」形态的动态,喂给现有的动态卡渲染器。
 *
 * 不新做视频卡:动态卡的版式编辑器、每类型样式、皮肤全都现成,拼一条动态就全拿到。
 * 字段照 B 站 `DYNAMIC_TYPE_AV` 抓包的样子摆 —— 模板只认那几个键。
 */

import type { VideoInfo } from "@bilibili-notify/api";
import type { Dynamic } from "@bilibili-notify/image";
import { formatClock, formatCount } from "@bilibili-notify/internal";

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
						duration_text: formatClock(info.duration),
						title: info.title,
						desc: info.desc,
						// 与卡片上别的计数同一份写法(渲染器自己也用它)。
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
