import { cut as jiebaCut } from "jieba-wasm";

/**
 * Per-subscription danmaku buffer powering the wordcloud + live-summary post-processing.
 *
 * 弹幕记在**订阅 id** 名下(不认房号、uid:收集器是中立的,哪个平台的订阅都能用)。
 *
 * - `recordViewerChat(subscriptionId, content, username)` segments the danmaku via jieba
 *   and updates both word-frequency and per-user count maps for that subscription.
 * - `snapshot(subscriptionId)` returns the sorted word list, the top senders list and the
 *   already-counted totals for passing to {@link WordcloudGenerator} / {@link LiveSummaryRequester}.
 * - `clear(subscriptionId)` is invoked at live-end after the wordcloud + summary have
 *   been dispatched (or the start of a new live session for that subscription).
 *
 * The collector intentionally does NOT decide whether collection is enabled —
 * the room-session-coordinator checks the wordcloud / liveSummary master+target gates
 * before calling `recordViewerChat`. This keeps the collector zero-config.
 */
export class ViewerChatCollector {
	// 两张表都是 `Map`:词与观众名是外来字符串,拿普通对象当查找表会读到
	// `constructor` / `toString` 这类原型上的函数(`__proto__` 更是整个键被吞掉)。
	/** subscriptionId → (word → count) */
	private readonly weightBySubscription = new Map<string, Map<string, number>>();
	/** subscriptionId → (username → count) */
	private readonly senderBySubscription = new Map<string, Map<string, number>>();

	private readonly stopwords: Set<string>;

	constructor(stopwords: Iterable<string>) {
		this.stopwords = new Set(stopwords);
	}

	/** Replace the active stop-word set (called on config update). */
	setStopwords(stopwords: Iterable<string>): void {
		this.stopwords.clear();
		for (const w of stopwords) this.stopwords.add(w);
	}

	/** Make sure a subscription is being tracked (called when listener starts). */
	register(subscriptionId: string): void {
		if (!this.weightBySubscription.has(subscriptionId)) {
			this.weightBySubscription.set(subscriptionId, new Map());
		}
		if (!this.senderBySubscription.has(subscriptionId)) {
			this.senderBySubscription.set(subscriptionId, new Map());
		}
	}

	/**
	 * Tokenise an incoming danmaku and update word-frequency + per-user count.
	 * Words shorter than 2 characters or in the stop-word set are dropped.
	 */
	recordViewerChat(subscriptionId: string, content: string, username: string): void {
		this.register(subscriptionId);
		const wordCounts = this.weightBySubscription.get(subscriptionId);
		const senderCounts = this.senderBySubscription.get(subscriptionId);
		if (!wordCounts || !senderCounts) return;

		jiebaCut(content, true)
			.filter((word: string) => word.length >= 2 && !this.stopwords.has(word))
			.forEach((w: string) => {
				wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
			});
		senderCounts.set(username, (senderCounts.get(username) ?? 0) + 1);
	}

	/**
	 * Read a sorted snapshot of the current buffer for a subscription.
	 *
	 * - `sortedWords`: descending by frequency.
	 * - `topSenders`: the five most active senders, descending by count (same shape as
	 *   `renderLiveSummary` / the AI prompt take).
	 * - `senderCount`: number of distinct usernames.
	 * - `viewerChatCount`: total danmaku recorded.
	 */
	snapshot(subscriptionId: string): {
		sortedWords: Array<[string, number]>;
		topSenders: Array<[string, number]>;
		senderCount: number;
		viewerChatCount: number;
	} {
		const weights = this.weightBySubscription.get(subscriptionId) ?? new Map<string, number>();
		const senders = this.senderBySubscription.get(subscriptionId) ?? new Map<string, number>();
		const sortedWords = [...weights].sort((a, b) => b[1] - a[1]);
		// 排序 / 人数 / 条数都在这里算好交出去,请求器不再自己重算一份。
		const topSenders = [...senders].sort((a, b) => b[1] - a[1]).slice(0, 5);
		let viewerChatCount = 0;
		for (const count of senders.values()) viewerChatCount += count;
		return {
			sortedWords,
			topSenders,
			senderCount: senders.size,
			viewerChatCount,
		};
	}

	/**
	 * 当前占着多少内存(按 key 数计)。
	 *
	 * 这两张表的 key 空间无界:词表随弹幕内容涨、发送者表随观众数涨,一场大主播
	 * 的长播能塞进几万个 key,而它们只在下播 / 换场时才 `clear`。给内存自检日志
	 * (server 端 `runtime/memory-probe.ts`)用,把这条曲线和堆用量画在同一行,
	 * 好回答「堆涨的时候是不是它在涨」。
	 *
	 * `senders` 报的是**跨订阅的 key 总数**而非去重人头 —— 占内存的就是 key 本身。
	 */
	stats(): { subscriptions: number; words: number; senders: number } {
		let words = 0;
		for (const rec of this.weightBySubscription.values()) words += rec.size;
		let senders = 0;
		for (const rec of this.senderBySubscription.values()) senders += rec.size;
		return { subscriptions: this.weightBySubscription.size, words, senders };
	}

	/** Drop all collected data for a subscription (called at live-end / room-stop). */
	clear(subscriptionId: string): void {
		this.weightBySubscription.delete(subscriptionId);
		this.senderBySubscription.delete(subscriptionId);
	}

	/** Drop everything (called on engine stop / login loss). */
	clearAll(): void {
		this.weightBySubscription.clear();
		this.senderBySubscription.clear();
	}
}
