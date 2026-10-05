/**
 * 把一条视频信息直接造成「投稿了视频」形态的作品,喂给出卡器(`ImageRenderer.generatePostCard`)。
 *
 * 不新做视频卡:动态卡的版式编辑器、每类型样式、皮肤全都现成,造一份 `Post` 就全拿到。手里有现成的数据
 * (播放 / 弹幕数是数字、时长是秒),**直接填进 `Post`**,不再伪造一条 B 站原始动态再让翻译层解析回来。
 *
 * 从前伪造的原始动态靠 `archive.badge.text === "投稿视频"` 这个隐含耦合才会贴「投稿了视频」标签;现在它是
 * 明说的 `label`。
 */

import type { VideoInfo } from "@bilibili-notify/api";
import type { Post } from "@bilibili-notify/internal";

/** unix 秒 → ISO;不是有效数就落在纪元(别让一个坏时间把整张卡弄抛)。 */
function isoOfSeconds(seconds: number): string {
	const date = new Date(seconds * 1000);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function videoToPost(info: VideoInfo): Post {
	return {
		// 头像不给:`Creator.avatar` 只收图库引用,B 站 3a 才存。
		creator: { name: info.owner.name },
		publishedAt: isoOfSeconds(info.pubdate),
		label: "投稿了视频",
		// 视频的简介在视频卡里,没有动态正文。
		text: "",
		video: {
			cover: { url: info.pic },
			title: info.title,
			description: info.desc,
			durationSec: info.duration,
			views: info.stat.view,
			danmaku: info.stat.danmaku,
		},
		stats: { shares: info.stat.share, comments: info.stat.reply, likes: info.stat.like },
	};
}
