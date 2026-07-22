import type { StatsRoastResult, StatsSoloRoastResult } from "@bilibili-notify/contract";
import { z } from "zod";

/**
 * AI 锐评的提示词构造与回复解析。
 *
 * 与模型交互的部分单独抽出来是因为它最不可靠:模型随时可能回一段带 markdown
 * 围栏的解释文、少一个字段、或者把 UP 名字写错一个字。这里的职责就是**把不
 * 可靠的自由文本压回一个可信的结构**,压不动就诚实失败,绝不半信半疑地渲染。
 *
 * **这里只写任务,不写身份。** 「你是谁、用什么口吻说话」全部由 system prompt
 * 里的人格负责(`CommentaryGenerator.getSystemPrompt()`),动态点评与下播总结的
 * user message 也都是这个规矩 —— 前者只说「XX 发布了一条动态,内容如下:…」,
 * 后者只说「请生成直播总结,弹幕发言人数:…」。曾经这两条提示词开头写着「你是
 * 一个毒舌但公正的 B 站数据女仆」,于是它和主人配的人格成了两条并列的身份指令,
 * 人格一旦不是毒舌女仆就串味,最后听谁的全看模型心情。
 *
 * 反过来,「评什么、输出什么形状」必须留在这里:锐评没有 dynamic / liveSummary
 * 那样可配的场景补充提示词,删过头会让默认人格交出一份味同嚼蜡的周报。
 */

/** 喂给模型的单个 UP。用下标而不是名字做引用键 —— 见 `RoastReplySchema`。 */
export interface RoastInput {
	uid: string;
	name: string;
	net7d: number | null;
	/** 整个统计窗口的净增合计。 */
	netWindow: number | null;
	/**
	 * 以下计数 `null` = 那段时间我们没在采集,与「确实是 0」严格两回事 ——
	 * prompt 里那句「标注为无记录的字段不要据此判定该 UP 偷懒」正是为它准备的。
	 * 曾经这几项恒为 number,于是没采集到的 UP 会顶着一排 0 被模型判成鸽王。
	 */
	archives: number | null;
	dynamics: number | null;
	liveSessions: number | null;
	liveHours: number | null;
	lastActivityAt: string | null;
}

/**
 * 模型回复的形状。
 *
 * **一律用下标 `i` 回指 UP,不用名字**:让模型复述中文昵称,它会漏字、改标点、
 * 把「机智的党妹」写成「党妹」,回来就匹配不上任何订阅。下标是单个整数,模型
 * 抄不错,越界也能一眼查出来。
 */
const RoastReplySchema = z.object({
	pigeon: z.object({ i: z.number().int(), reason: z.string().min(1) }),
	diligent: z.object({ i: z.number().int(), reason: z.string().min(1) }),
	roast: z.array(z.object({ i: z.number().int(), comment: z.string().min(1) })).default([]),
	scores: z.array(z.object({ i: z.number().int(), score: z.number() })).default([]),
	pushText: z.string().default(""),
});

export function buildRoastPrompt(ups: readonly RoastInput[], days: number): string {
	const table = ups.map((u, i) => ({
		i,
		名称: u.name,
		近7日粉丝: u.net7d ?? "无记录",
		[`近${days}日粉丝`]: u.netWindow ?? "无记录",
		投稿: u.archives ?? "无记录",
		动态: u.dynamics ?? "无记录",
		直播场次: u.liveSessions ?? "无记录",
		直播时长h: u.liveHours === null ? "无记录" : Math.round(u.liveHours * 10) / 10,
		最后活动: u.lastActivityAt ?? "无记录",
	}));
	return [
		`以下是我订阅的 ${ups.length} 位 B 站 UP 主近 ${days} 天的数据(JSON):`,
		JSON.stringify(table),
		"",
		"请评选出「鸽王」(最不勤奋:掉粉/停更/投稿直播都少)和「勤奋 UP」(更新最勤/涨粉最猛),",
		"并对若干 UP 给出简短锐评。",
		"",
		"严格只输出如下 JSON,不要任何多余文字、解释或 markdown 围栏:",
		'{"pigeon":{"i":0,"reason":""},"diligent":{"i":0,"reason":""},',
		'"roast":[{"i":0,"comment":""}],"scores":[{"i":0,"score":0}],"pushText":""}',
		"",
		"要求:",
		"- pigeon / diligent / roast / scores 里的 i 字段一律填上表的下标(整数),不要写名字;",
		"- reason 一句话;roast 给出 3-4 条最有梗的锐评;",
		`- scores 必须覆盖全部 ${ups.length} 位 UP,score 为 0-100 的综合勤奋度评分(越勤奋越高);`,
		"- 标注为「无记录」的字段表示我们那段时间没有采集到数据,不要据此判定该 UP 偷懒;",
		"- pushText 是一段可直接发到群里的中文周报(120 字内,可带少量 emoji)。",
		"  **它是唯一给人读的字段**:里面提到 UP 时一律写上表的「名称」,不要出现下标",
		"  (读者手上没有这张表,写「i=0」他们不知道是谁)。",
	].join("\n");
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 依次剥掉 markdown 围栏、再退到首个 `{` 与末个 `}` 之间 —— 模型很爱在 JSON
 * 前后加一句「好的,这是您要的结果:」。
 */
function extractJson(raw: string): unknown {
	let s = raw.trim();
	const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced?.[1]) s = fenced[1].trim();
	const a = s.indexOf("{");
	const b = s.lastIndexOf("}");
	if (a >= 0 && b > a) s = s.slice(a, b + 1);
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/**
 * 把 `pushText` 里残留的下标回指换回 UP 名称。
 *
 * 下标纪律(见 {@link RoastReplySchema})只对 **JSON 结构字段**成立,`pushText`
 * 却是**直接发到群里**的自然语言。模型分不清这两层 —— 提示词早先笼统地写着
 * 「所有对 UP 的引用一律使用下标」,于是推出去的周报长这样:
 *
 *   「📊本周UP主周报:鸽王i=0,30天零投稿零直播却涨粉;劳模i=5直播3场独撑排面。」
 *
 * 群友手上没有那张表,这段话对他们等于没写。提示词现在分开讲了,这里是第二道
 * 防线:那段文本发出去就收不回来,而模型永远有权不听话。
 *
 * **越界下标原样保留** —— 换成任何一个真名都是往无辜的 UP 头上安话,而留着
 * 「i=99」至少一眼看得出是模型出了错。与 `parseRoastReply` 丢弃越界下标同源。
 */
function inlineUpNames(text: string, ups: readonly RoastInput[]): string {
	// `i=0` / `i = 0` / `i0` / `i 0` 四种写法都见过。前置 \b 保证只吃独立的 i,
	// 名字里本来就带的字母数字(如「Ai2」)不受影响。
	return text.replace(/\bi\s*=?\s*(\d+)\b/gi, (m, d: string) => ups[Number(d)]?.name ?? m);
}

/**
 * 把模型回复解析成可渲染的结构,并把下标映射回 uid。
 *
 * 越界下标一律丢弃而不是 clamp:clamp 会把模型的胡话安到一个无辜的 UP 头上,
 * 而这张卡是要发到群里的。鸽王 / 勤奋 UP 任一越界即整体失败 —— 这两个是卡片
 * 的主体,缺一个就没什么可展示的了。
 */
export function parseRoastReply(raw: string, ups: readonly RoastInput[]): StatsRoastResult | null {
	const json = extractJson(raw);
	if (json === null) return null;
	const parsed = RoastReplySchema.safeParse(json);
	if (!parsed.success) return null;

	const uidAt = (i: number): string | null => ups[i]?.uid ?? null;
	const pigeonUid = uidAt(parsed.data.pigeon.i);
	const diligentUid = uidAt(parsed.data.diligent.i);
	if (!pigeonUid || !diligentUid) return null;

	return {
		pigeon: { uid: pigeonUid, reason: parsed.data.pigeon.reason },
		diligent: { uid: diligentUid, reason: parsed.data.diligent.reason },
		roast: parsed.data.roast.flatMap((r) => {
			const uid = uidAt(r.i);
			return uid ? [{ uid, comment: r.comment }] : [];
		}),
		scores: parsed.data.scores.flatMap((s) => {
			const uid = uidAt(s.i);
			// 评分越界一律夹到 0..100:这个数只驱动一根进度条,夹一下比整卡失败划算。
			return uid ? [{ uid, score: Math.max(0, Math.min(100, Math.round(s.score))) }] : [];
		}),
		pushText: inlineUpNames(parsed.data.pushText, ups),
	};
}

// ── 单 UP 锐评 ───────────────────────────────────────────────────────────────

/**
 * 单人锐评的回复形状。
 *
 * 这里不需要下标回指 —— 只有一位 UP,uid 由服务端从入参带出,压根不让模型碰。
 * 模型唯一能污染的就是文本内容本身。
 */
const SoloRoastReplySchema = z.object({
	verdict: z.string().min(1),
	score: z.number(),
	highlights: z
		.array(z.object({ label: z.string().min(1), comment: z.string().min(1) }))
		.default([]),
	pushText: z.string().default(""),
});

export function buildSoloRoastPrompt(up: RoastInput, days: number): string {
	const data = {
		名称: up.name,
		近7日粉丝: up.net7d ?? "无记录",
		[`近${days}日粉丝`]: up.netWindow ?? "无记录",
		投稿: up.archives ?? "无记录",
		动态: up.dynamics ?? "无记录",
		直播场次: up.liveSessions ?? "无记录",
		直播时长h: up.liveHours === null ? "无记录" : Math.round(up.liveHours * 10) / 10,
		最后活动: up.lastActivityAt ?? "无记录",
	};
	return [
		`以下是我订阅的一位 B 站 UP 主近 ${days} 天的数据(JSON):`,
		JSON.stringify(data),
		"",
		"请只针对这一位 UP 主作出评价 —— 他这段时间是勤快还是在鸽,",
		"涨粉掉粉说明了什么,投稿与直播的节奏如何。",
		"",
		"严格只输出如下 JSON,不要任何多余文字、解释或 markdown 围栏:",
		'{"verdict":"","score":0,"highlights":[{"label":"","comment":""}],"pushText":""}',
		"",
		"要求:",
		"- verdict 是一句话总评(40 字内),要有梗但别造谣;",
		"- score 是 0-100 的综合勤奋度评分(越勤奋越高);",
		"- highlights 给 3-4 条分维度点评,label 是维度名(如「涨粉」「投稿」「直播」),comment 一句话;",
		"- 没有对照组,**不要**和「其他 UP」比较,只就他自己的数据说话;",
		"- 标注为「无记录」的字段表示我们那段时间没有采集到数据,不要据此判定该 UP 偷懒;",
		"- pushText 是一段可直接发到群里的中文短评(80 字内,可带少量 emoji)。",
	].join("\n");
}

/**
 * 解析单人锐评。`uid` 一律从入参带出,不读模型回复里的同名字段 ——
 * 模型没有任何理由知道 uid,它写出来的只可能是幻觉。
 */
export function parseSoloRoastReply(raw: string, up: RoastInput): StatsSoloRoastResult | null {
	const json = extractJson(raw);
	if (json === null) return null;
	const parsed = SoloRoastReplySchema.safeParse(json);
	if (!parsed.success) return null;
	return {
		uid: up.uid,
		verdict: parsed.data.verdict,
		// 与榜单口径一致:评分只驱动一根进度条,夹一下比整卡失败划算。
		score: Math.max(0, Math.min(100, Math.round(parsed.data.score))),
		highlights: parsed.data.highlights,
		pushText: parsed.data.pushText,
	};
}
