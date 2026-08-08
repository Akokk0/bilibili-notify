import { cut as jiebaCut } from "jieba-wasm";

/**
 * Per-room danmaku buffer powering the wordcloud + live-summary post-processing.
 *
 * - `recordDanmaku(roomId, content, username)` segments the danmaku via jieba
 *   and updates both word-frequency and per-user count maps for that room.
 * - `snapshot(roomId)` returns the sorted word list + raw sender map for
 *   passing to {@link WordcloudGenerator} / {@link LiveSummaryRequester}.
 * - `clear(roomId)` is invoked at live-end after the wordcloud + summary have
 *   been dispatched (or the start of a new live session for that room).
 *
 * The collector intentionally does NOT decide whether collection is enabled —
 * the listener-manager checks the wordcloud / liveSummary master+target gates
 * before calling `recordDanmaku`. This keeps the collector zero-config.
 */
export class DanmakuCollector {
	/** roomId → { word: count } */
	private readonly weightByRoom = new Map<string, Record<string, number>>();
	/** roomId → { username: count } */
	private readonly senderByRoom = new Map<string, Record<string, number>>();

	private readonly stopwords: Set<string>;

	constructor(stopwords: Iterable<string>) {
		this.stopwords = new Set(stopwords);
	}

	/** Replace the active stop-word set (called on config update). */
	setStopwords(stopwords: Iterable<string>): void {
		this.stopwords.clear();
		for (const w of stopwords) this.stopwords.add(w);
	}

	/** Make sure a room is being tracked (called when listener starts). */
	registerRoom(roomId: string): void {
		if (!this.weightByRoom.has(roomId)) this.weightByRoom.set(roomId, {});
		if (!this.senderByRoom.has(roomId)) this.senderByRoom.set(roomId, {});
	}

	/**
	 * Tokenise an incoming danmaku and update word-frequency + per-user count.
	 * Words shorter than 2 characters or in the stop-word set are dropped.
	 */
	recordDanmaku(roomId: string, content: string, username: string): void {
		this.registerRoom(roomId);
		const wordRecord = this.weightByRoom.get(roomId);
		const senderRecord = this.senderByRoom.get(roomId);
		if (!wordRecord || !senderRecord) return;

		jiebaCut(content, true)
			.filter((word: string) => word.length >= 2 && !this.stopwords.has(word))
			.forEach((w: string) => {
				wordRecord[w] = (wordRecord[w] || 0) + 1;
			});
		senderRecord[username] = (senderRecord[username] || 0) + 1;
	}

	/**
	 * Read a sorted snapshot of the current buffer for a room.
	 *
	 * - `sortedWords`: descending by frequency.
	 * - `senderRecord`: raw username → count map (consumer decides ordering).
	 * - `senderCount`: number of distinct usernames.
	 * - `danmakuCount`: total danmaku recorded.
	 */
	snapshot(roomId: string): {
		sortedWords: Array<[string, number]>;
		senderRecord: Record<string, number>;
		senderCount: number;
		danmakuCount: number;
	} {
		const weights = this.weightByRoom.get(roomId) ?? {};
		const senders = this.senderByRoom.get(roomId) ?? {};
		const sortedWords = Object.entries(weights).sort((a, b) => b[1] - a[1]);
		const senderCount = Object.keys(senders).length;
		const danmakuCount = Object.values(senders).reduce((sum, val) => sum + val, 0);
		return {
			sortedWords,
			senderRecord: { ...senders },
			senderCount,
			danmakuCount,
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
	 * `senders` 报的是**跨房间的 key 总数**而非去重人头 —— 占内存的就是 key 本身。
	 */
	stats(): { rooms: number; words: number; senders: number } {
		let words = 0;
		for (const rec of this.weightByRoom.values()) words += Object.keys(rec).length;
		let senders = 0;
		for (const rec of this.senderByRoom.values()) senders += Object.keys(rec).length;
		return { rooms: this.weightByRoom.size, words, senders };
	}

	/** Drop all collected data for a room (called at live-end / room-stop). */
	clear(roomId: string): void {
		this.weightByRoom.delete(roomId);
		this.senderByRoom.delete(roomId);
	}

	/** Drop everything (called on engine stop / auth-lost). */
	clearAll(): void {
		this.weightByRoom.clear();
		this.senderByRoom.clear();
	}
}
