/**
 * 画布上拖块的**几何与落位算法**(ADR-0014「仍未决」里主人 2026-09-14 要进账的那条:
 * 拖动改行列、拉边改跨列)。
 *
 * **与 DOM 分开**是硬要求,不是洁癖:jsdom 没有布局引擎,`getBoundingClientRect()` 一律
 * 回 0,这里的算法要是写在组件里就一条也钉不住 —— 而「拖到第几列」恰恰是全部难点所在。
 * 组件那半只负责量出轨道、把指针坐标递进来,薄到一眼能看完。
 *
 * 两条刻意的规矩:
 * - **移动就只是移动**:块顶到边就停住,跨度一个不改。顺手帮人缩一列,他下一次拖回来
 *   会发现块变窄了,而这一下他根本没打算改宽度。
 * - **按抓住的位置平移**,不是把块的左边贴到指针上 —— 抓着块的右半边拖,块会整个往左
 *   跳一截,那是所有人第一次拖就会骂的那种手感。
 */

import { CARD_SKIN_LIMITS } from "@bilibili-notify/internal/constants";
import { gridsOverlap } from "./skin-draft-ops";

/** 一条网格轨道在屏幕上的范围(px);列用横向、行用纵向,同一套算法。 */
export interface Track {
	readonly start: number;
	readonly end: number;
}

/**
 * 块在网格里的位置。拖拽只改前三个数 —— `rowSpan` 拖不着(留给检查器),但落点指示要画得
 * 跟块一样高,所以它跟着一起带过来。
 */
export interface GridPos {
	readonly row: number;
	readonly column: number;
	readonly span: number;
	readonly rowSpan?: number;
}

/**
 * 指针落在的那条轨道(1 起)。轨道按**半开区间 `[start, end)`** 算 —— 两条轨道贴着时
 * 边界那一像素归后一条,不然它会同时属于两条,而「同时属于两条」在这儿只会表现成
 * 「拖到列边界上时块偶尔往回跳一格」。落在缝里或出界取最近的一条。
 */
export function trackAt(tracks: readonly Track[], pos: number): number {
	if (tracks.length === 0) return 1;
	for (const [i, t] of tracks.entries()) {
		if (pos >= t.start && pos < t.end) return i + 1;
	}
	// 缝里或出界:取边缘离得最近的那条。画布的列之间真有 gap,指针一定会落在缝里。
	let best = 1;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const [i, t] of tracks.entries()) {
		const gap = pos < t.start ? t.start - pos : pos - t.end;
		if (gap < bestGap) {
			bestGap = gap;
			best = i + 1;
		}
	}
	return best;
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

/**
 * 拖块身:落到指针那一格,**按抓住的位置平移**(`grabOffset` = 按下时指针在块内的第几格,
 * 0 起)。块顶到第 1 / 第 12 列就停住,跨度不动。
 */
export function movedGrid(
	grid: GridPos,
	at: { column: number; row: number },
	grabOffset: number,
): { row: number; column: number } {
	const cols = CARD_SKIN_LIMITS.columns;
	return {
		row: clamp(at.row, 1, CARD_SKIN_LIMITS.maxRows),
		column: clamp(at.column - grabOffset, 1, cols - grid.span + 1),
	};
}

/** 三重闸看得见的那半:别的块占着哪儿,以及它**是不是一定会出现**。 */
export interface StackPeer {
	readonly grid: GridPos;
	/** 写了 `showIf` 的块不算 —— 见 {@link solidStackDepth}。 */
	readonly solid: boolean;
}

/**
 * 同一片格子上**最多叠三层**(2026-09-16 主人:「三重都还好,四重就乱掉了」)。
 *
 * 这个数不是随便定的,它正是**画布画得清的层数**:横向错位每层 8px、封两档,于是三层的
 * 左边缘是 -16 / -8 / 0 三档各不同;到第四层封顶生效,最上面两条露边**重合**,看着就是糊的。
 *
 * ⚠️ **这是画布拖拽的闸,不是数据契约。** 检查器的行列数字框是精确编辑(ADR 说过它不该
 * 有副作用)、皮肤包 schema 也照旧放行 —— 手写的、别人分享的皮肤装得进来,装进来之后
 * 画布上会是挤的,但出图那头四重一点问题都没有(层次照样表达得清)。三处分别拦不拦由
 * 主人 2026-09-16 拍板。
 */
export const MAX_SOLID_STACK = 3;

/**
 * 落到 `at` 这个格子上,同一片地方会有几个**一定同时出现**的块(含自己)。
 *
 * **写了 `showIf` 的一个都不数。** 编辑器判不出运行时哪个为真,但判得出有没有写 ——
 * 而「有视频画视频卡、有图廊画图廊,两个块摆同一处」是 ADR 明写的正当技巧:它们出图时
 * 互斥,根本不叠。只按格子数的话,四种形态各摆一个块就被这道闸堵死了。
 *
 * 相交判据从 `skin-draft-ops` 借,**不在这儿另写一份**:那边的 `overlappingBlocks` 问的是
 * 「现在谁跟谁叠着」(画布照它画深浅),这儿问的是「落过去会不会叠成第四层」。两份算法
 * 只要有一点对不上,拦住的和画出来的就是两回事。
 */
export function solidStackDepth(
	at: GridPos,
	selfSolid: boolean,
	peers: readonly StackPeer[],
): number {
	let n = selfSolid ? 1 : 0;
	for (const p of peers) if (p.solid && gridsOverlap(at, p.grid)) n++;
	return n;
}

/**
 * 拉边:右边跟着指针走(`column` 不动),左边跟着指针走而**右边钉住**。两头都至少留 1 列。
 */
export function resizedGrid(
	grid: GridPos,
	edge: "left" | "right",
	column: number,
): { column: number; span: number } {
	const cols = CARD_SKIN_LIMITS.columns;
	if (edge === "right") {
		return {
			column: grid.column,
			span: clamp(column - grid.column + 1, 1, cols - grid.column + 1),
		};
	}
	// 右边界钉住:它是「最后一列的下一列」,所以新跨度 = 右边界 - 新起点。
	const rightEdge = grid.column + grid.span;
	const start = clamp(column, 1, rightEdge - 1);
	return { column: start, span: rightEdge - start };
}

// ── 松手之后 ──────────────────────────────────────────────────────────────────

/**
 * **动量投射** —— 以这个速度甩出去,最终会停在多远的地方(px)。
 *
 * 这是 Apple 在 *Designing Fluid Interfaces* 里给的那条**指数衰减**公式,不是教科书的
 * `v²/(2a)`。两条曲线都"物理正确",但只有前者是 iOS 那个手感,而这件事要的全部就是手感。
 *
 * 用途:落点不按**松手时块在哪**算,按**甩出去会停到哪**算 —— 轻轻放下就落回原地,
 * 用力一甩能多走几格。拿一个小输入,换一个大输出。
 *
 * @param velocity px/s
 * @param decelerationRate 0.998 是正常滚动手感,0.99 收得更快
 */
export function project(velocity: number, decelerationRate = 0.998): number {
	return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** 松手那一刻的速度,px/s,两轴各算各的。 */
export interface Velocity {
	readonly x: number;
	readonly y: number;
}

/**
 * 指针轨迹的取样器 —— 松手时要把**手的速度**交给弹簧,拖与弹之间才没有接缝。
 *
 * **只看最后两个点是不行的**:手指常常在终点上停留一小会儿,那两帧的位移是 0,算出来的
 * 速度也是 0 —— 明明甩出去了,却一点惯性都没有。所以取最近一段时间窗里的首尾之差。
 *
 * 两轴分开算(Apple:把 2D 拆成各自独立的 X / Y 弹簧)—— 合成一个 2D 速度会在两轴快慢
 * 不同时失真。
 */
/**
 * 速度封顶(px/s)。**不是为了测试,是真会炸**:两次指针事件相隔一毫秒、中间挪了两百像素
 * 的话,算出来是二十万 px/s,投射出去块就飞到网格外面了。抖动、断帧、后台标签页切回来
 * 都能造出这种一毫秒。3000 配着下面那档减速率,一次有力的甩大约多走五列 —— 够狠,但还
 * 在这张网格上。
 */
const MAX_SPEED = 3000;

const clampSpeed = (v: number) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));

export function createVelocityTracker(windowMs = 100): {
	add(x: number, y: number, t: number): void;
	velocity(t: number): Velocity;
} {
	let points: Array<{ x: number; y: number; t: number }> = [];
	const trim = (t: number) => {
		// 留一个窗口外的点当"起点":全扔掉的话,窗口里只剩一个点就永远算不出速度。
		const cut = points.findIndex((p) => p.t >= t - windowMs);
		if (cut > 0) points = points.slice(cut - 1);
	};
	return {
		add(x, y, t) {
			points.push({ x, y, t });
			trim(t);
		},
		velocity(t) {
			trim(t);
			const first = points[0];
			const last = points[points.length - 1];
			if (!first || !last) return { x: 0, y: 0 };
			// 首尾同一时刻(或只有一个点)→ 没有可算的速度,别吐 NaN / Infinity。
			const dt = last.t - first.t;
			if (dt <= 0) return { x: 0, y: 0 };
			return {
				x: clampSpeed(((last.x - first.x) / dt) * 1000),
				y: clampSpeed(((last.y - first.y) / dt) * 1000),
			};
		},
	};
}

/**
 * 系统里关了动效没有。**关了就一步到位**,不是把时长调短 —— 前庭敏感的人要的是「不要动」,
 * 不是「动得快一点」。1:1 跟手那部分照旧:那是直接操作,不是动画。
 *
 * `matchMedia` 取不到时当**没关**(浏览器里它一定在;取不到的是测试环境这类没有它的地方,
 * 那儿本来也不播动画)。
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
