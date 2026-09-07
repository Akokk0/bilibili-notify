/**
 * WS `resources` 频道的载荷 —— 概览页「系统资源」卡看的全部数字。
 *
 * 订阅即收一帧 `hydrate`(静态量 + 近 5 分钟的样本),之后每个采样 tick 一帧 `sample`。
 * 所有字节数都是原始 byte,百分比都是 0..1 的比例;单位换算与阈值染色归面板。
 */

/** 启动期定死、整个进程生命周期不变的量。 */
export interface ResourceStatic {
	/** `os.cpus()[0].model`;容器里就是宿主机的。 */
	cpuModel: string;
	/** 宿主机逻辑核数(`os.cpus().length`)。 */
	hostCores: number;
	/**
	 * 本体 CPU 占比的分母(可用核数):cgroup `cpu.max` 有配额按配额(可以是小数),
	 * 否则就是 `hostCores`。
	 */
	cpuBudget: number;
	/** 内存总量(byte):cgroup 有上限取上限(再与宿主机总量取小),否则宿主机总量。 */
	memTotal: number;
	/** `memTotal` 的来路 —— 面板要说清「这是容器配额」还是「这是整台机器」。 */
	memSource: "cgroup" | "host";
	/** V8 堆上限(byte),`--max-old-space-size` 压过的就是那个值。 */
	heapLimit: number;
}

/** 浏览器那一行的状态:没接 puppeteer / 本地跑着 / 空闲已关 / 远程(拿不到 pid)。 */
export type BrowserProcessState = "none" | "running" | "closed" | "remote";

/** 每个采样 tick 一份。 */
export interface ResourceSample {
	/** 采样时刻(epoch ms)。 */
	ts: number;
	/** 宿主机 CPU 使用率 0..1;首个样本没有上一次的 tick 可比,为 null。 */
	hostCpu: number | null;
	/** 宿主机 / 容器已用内存(byte)。 */
	memUsed: number;
	/** 本体进程 CPU 占比 0..1(÷ `cpuBudget`);首个样本为 null。 */
	procCpu: number | null;
	/** 本体堆已用(byte)。 */
	heapUsed: number;
	/** 本体 RSS(byte)。 */
	rss: number;
	/** 浏览器进程子树 RSS 合计(byte);不在跑 / 远程 / 还没量到为 null。 */
	browserRss: number | null;
	browserState: BrowserProcessState;
}

export interface ResourcesHydrate {
	static: ResourceStatic;
	/** 近 5 分钟的样本,旧在前新在后;刚启动时不满。 */
	history: ResourceSample[];
}
