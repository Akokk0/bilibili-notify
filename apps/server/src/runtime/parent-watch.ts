/**
 * 孤儿自检 —— 桌面版 sidecar 发现父进程没了就自己退掉。
 *
 * **为什么需要**:sidecar 是 launcher 起的子进程,但 Unix 下父进程死掉**不会**带走
 * 子进程 —— 它会被 launchd(或别的 subreaper)收养继续跑。launcher 正常退出时会
 * 主动停 sidecar,可它自己被强杀 / 崩溃时就没人停了。
 *
 * 2026-08-31 实地踩到的后果比「多一个进程」严重得多:一个孤儿 sidecar 活了三个
 * 小时,期间某次构建把它正在执行的 node 二进制覆盖写了一遍,macOS 的签名缓存
 * 随即失效,**之后所有新 sidecar 一 exec 就被 SIGKILL**,桌面版整个起不来,而
 * stderr 是空的(来不及输出)—— 从症状完全看不出根源在一个几小时前的孤儿身上。
 *
 * 判据是「**父进程还是不是原来那个**」,不是「ppid 是不是 1」:收养目标不保证是 1
 * (可能是 subreaper),而拿原始 ppid 直接比,顺带也免疫 pid 复用 —— 我们比的是
 * 自己当前的父进程,不是去探测某个 pid 还在不在。
 *
 * 只在 `BN_PARENT_PID` 存在时生效,所以 Docker / 直接跑服务端完全不受影响。
 */

/** 检查间隔。孤儿的代价是持续占着数据目录,几秒的发现延迟无所谓,别空转太勤。 */
export const PARENT_WATCH_INTERVAL_MS = 3_000;

/**
 * 解析 `BN_PARENT_PID`。
 *
 * 看不懂就返回 null（关掉），**不猜也不报错**:这是个兜底守卫,值坏了最多是回到
 * 没有守卫的状态;要是反过来把坏值当成某个 pid,就会立刻误判成孤儿自杀,
 * 那比不装这个守卫糟得多。
 *
 * `0` / `1` 同样当没有:ppid 为 1 意味着「一出生就是孤儿」,盯着它永远不会触发,
 * 是个只会让人误以为有保护的假守卫。
 */
export function resolveExpectedParent(raw: string | undefined): number | null {
	if (!raw) return null;
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n <= 1) return null;
	return n;
}

export interface ParentWatchDeps {
	/** 启动时记下的父进程 pid。 */
	expectedParent: number;
	/** 读当前 ppid。省略则 `process.ppid`(每次访问都是实时值)。 */
	getPpid?: () => number;
	/** 判定成孤儿时调用。生产实现是给自己发 SIGTERM,复用现成的优雅关停路径。 */
	onOrphaned: () => void;
	/** 注入定时器,生产传 `serviceCtx.setInterval`,这样 dispose 时会被一起停掉。 */
	schedule: (fn: () => void, ms: number) => void;
	intervalMs?: number;
}

export function startParentWatch(deps: ParentWatchDeps): void {
	const read = deps.getPpid ?? (() => process.ppid);
	let fired = false;
	deps.schedule(() => {
		// 关停是个异步过程,期间定时器还在跑。不上闩就会每 3 秒再喊一次,
		// 把正在收尾的关停打断成一团乱。
		if (fired) return;
		let ppid: number;
		try {
			ppid = read();
		} catch {
			// 读不到 ppid 不是「父进程没了」的证据。守卫宁可失灵,也不能误杀 ——
			// 更不能让它自己抛出去把进程带走(那正是它要防的事)。
			return;
		}
		if (ppid === deps.expectedParent) return;
		fired = true;
		deps.onOrphaned();
	}, deps.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
}
