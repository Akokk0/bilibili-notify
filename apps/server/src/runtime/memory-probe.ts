import { getHeapStatistics } from "node:v8";
import type { ServiceContext } from "@bilibili-notify/internal";

/**
 * 周期性内存自检 —— 把「堆用了多少 / 离天花板多远」按固定节奏写进日志归档。
 *
 * **为什么默认开着、而且写 info**:镜像给 V8 压了 old-space 上限(见
 * `apps/Dockerfile`),撞上去就是 `FATAL ERROR: Reached heap limit`,进程当场死。
 * 那份 V8 尾巴日志能告诉我们「堆满了」,却回答不了唯一要紧的问题:**它是一上来
 * 就吃这么多,还是几个小时慢慢涨上去的**。前者是容量不够,后者是泄漏,修法完全
 * 相反。等用户报障了再叫他打开采样,就得再赌一次崩溃——而这类崩溃间隔以小时计。
 * 所以这条曲线必须在事发之前就已经记着;降成 debug(默认不输出)等于废掉它。
 *
 * 噪音是可接受的代价:默认 10 分钟一条,一天 144 行,在按天分卷的 jsonl 归档里
 * 什么都不是,Logs Tab 也能按 level / 模块滤掉。
 */

const BYTES_PER_MB = 1024 * 1024;

/** heapUsed 占上限超过这个比例就升 warn —— 留给用户反应的余地,而不是等 FATAL。 */
const WARN_RATIO = 0.85;

/** 默认 10 分钟一条:一天 144 行,足够画出以小时计的泄漏曲线,又不至于淹掉归档。 */
const DEFAULT_INTERVAL_SECONDS = 600;

/** 下限:1 秒一条能把按天分卷的 jsonl 刷爆,谁也不想要那个。 */
const MIN_INTERVAL_SECONDS = 30;

/**
 * 解析 `BN_MEMORY_PROBE_SECONDS`。
 *
 * `0` 是明确的关闭意图,照办;**看不懂的值一律退回默认**,而不是当成关闭 ——
 * 打错一个字就把唯一那条内存曲线静默关掉,等到需要它时才发现一直没记,
 * 是这里最坏的失败方式。
 */
export function resolveProbeInterval(raw: string | undefined): number {
	if (!raw) return DEFAULT_INTERVAL_SECONDS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_SECONDS;
	if (n === 0) return 0;
	return Math.max(MIN_INTERVAL_SECONDS, Math.round(n));
}

/** 只取用得上的四个字段,方便测试注入(完整 MemoryUsage 还有 arrayBuffers 等)。 */
export interface MemoryUsageSample {
	rss: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
}

export interface MemoryProbeDeps {
	serviceCtx: ServiceContext;
	/** 采样间隔(秒)。 */
	intervalSeconds: number;
	/** 堆上限(字节)。省略则问 V8 要 —— 生产就是 NODE_OPTIONS 那个值。 */
	heapLimitBytes?: number;
	/** 读一次用量。省略则 `process.memoryUsage()`。 */
	readUsage?: () => MemoryUsageSample;
	/**
	 * 业务规模采样点,每个返回一小段人话拼进同一行。
	 *
	 * 「堆涨了」本身不指向任何人;要定位得知道**同一时刻哪个结构在涨**。所以
	 * 这些计数必须和进程级数字同行输出,分开写就得靠时间戳配对,读日志的人不会干。
	 */
	probes?: ReadonlyArray<() => string>;
}

function mb(bytes: number): number {
	return Math.round(bytes / BYTES_PER_MB);
}

export function startMemoryProbe(deps: MemoryProbeDeps): void {
	// 关得掉是硬要求:嫌吵的人否则只能去调 log level,那会把别的日志一起关掉。
	if (deps.intervalSeconds <= 0) return;

	const read = deps.readUsage ?? (() => process.memoryUsage());
	const limit = deps.heapLimitBytes ?? getHeapStatistics().heap_size_limit;

	deps.serviceCtx.setInterval(() => {
		const u = read();
		const ratio = u.heapUsed / limit;
		// 采样点是「顺便问一句」,不是主线 —— 谁抛了就跳过谁,绝不能让一个业务
		// 计数把整条内存曲线带断。
		const extra: string[] = [];
		for (const probe of deps.probes ?? []) {
			try {
				const s = probe();
				if (s) extra.push(s);
			} catch {
				// 引擎可能还没起来 / 已经拆了,不是内存自检该管的事。
			}
		}
		const tail = extra.length > 0 ? ` | ${extra.join(" | ")}` : "";
		// heapUsed 只说「现在装了多少」。跟已提交量(heapTotal)一起看,才知道 V8 为此
		// 实际占了多少、又有多少是回收不掉的碎片 —— used 平、committed 一路涨,
		// 就是碎片化而不是业务在存东西。
		const line =
			`[mem] heap ${mb(u.heapUsed)}/${mb(limit)}MB (${Math.round(ratio * 100)}%, 已提交 ${mb(u.heapTotal)}MB) ` +
			`rss ${mb(u.rss)}MB external ${mb(u.external)}MB${tail}`;
		if (ratio >= WARN_RATIO) {
			// 后果必须写出来。只报一个百分比,读日志的人不知道该不该管它。
			deps.serviceCtx.logger.warn(
				`${line} —— 已逼近堆上限,再涨会 FATAL(Reached heap limit)整个进程退出。` +
					`可在 compose 的 environment 里设 NODE_OPTIONS=--max-old-space-size=<更大的值> 先撑住。`,
			);
			return;
		}
		deps.serviceCtx.logger.info(line);
	}, deps.intervalSeconds * 1000);
}
