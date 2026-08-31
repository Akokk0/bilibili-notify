import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 导览的完成反馈件 —— 主步判据变绿的那一拍就地庆祝。
 *
 * - StepDoneBadge:屏幕中央弹出「✓ 完成」大胶囊(主人定案:挂操作位置太不
 *   起眼,居中放大才看得见),动画演完自卸 —— 不然小卡文案无声切到下一步,
 *   用户不知道刚才那步已经成了;**减动效档换静态样式**(见下方);
 * - Fireworks:五步全绿的毕业时刻,全屏 canvas 烟花放一场(prefers-reduced-motion
 *   时整场跳过)。指针事件全穿透,谁也不挡。
 *
 * 两件的减动效口径**故意不同**:烟花是纯装饰,整场跳过没有损失;徽章带着
 * 「刚才那步成了」这条信息,不能跳 —— 只把演出去掉,让它静静站一会儿。
 */

/** 徽章那段 keyframes 的时长(styles.css 的 .bn-tour-done),兜底自卸按它算。 */
const DONE_BADGE_MS = 2_200;
/** 减动效档不演动画,站这么久就走。 */
const DONE_BADGE_REDUCED_MS = 1_600;

/**
 * 完成徽章:屏幕中央弹出,一段 keyframes 演完(onAnimationEnd)自卸。
 *
 * 减动效档改挂静态样式 —— 兄弟件 Fireworks 早就认 `prefers-reduced-motion`,
 * 而这枚徽章的 2.2 秒缩放+上飘 keyframes 一直是无条件跑的(styles.css 里那几段
 * reduced-motion 只盖了小卡/标签、流光和玻璃抬升),每完成一步就在减动效用户
 * 脸上弹一次(2026-08-31 审查)。
 */
export function StepDoneBadge({ text, onDone }: { text: string; onDone: () => void }) {
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;
	// 挂载那刻定死:中途改系统设置会让「挂哪个 class」和「靠什么自卸」对不上,
	// 而对不上的那一半就是永远卸不掉。
	const [reduced] = useState(
		() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
	);
	useEffect(() => {
		// 兜底自卸。唯一的卸载路径是 onAnimationEnd 的话,哪天有人给 .bn-tour-done
		// 补一句 `animation: none`(比如顺手加一条 reduced-motion 规则),事件就永远
		// 不来,徽章会一直挂在页面上直到刷新。计时器让这条路封死。
		const timer = setTimeout(
			() => onDoneRef.current(),
			reduced ? DONE_BADGE_REDUCED_MS : DONE_BADGE_MS + 400,
		);
		return () => clearTimeout(timer);
	}, [reduced]);
	return createPortal(
		<div
			data-testid="tour-done-badge"
			aria-hidden
			className={`${reduced ? "bn-tour-done-static" : "bn-tour-done"} pointer-events-none fixed left-1/2 top-1/2 z-bn-tour-panel`}
			// animationend 会冒泡:里面那颗玻璃胶囊是皮肤最爱挂动画的面(bn-anim-aura
			// 之类),它一演完就会冒上来把整块徽章提前卸掉,2.2 秒变一闪而过。
			onAnimationEnd={(e) => {
				if (e.currentTarget !== e.target) return;
				onDone();
			}}
		>
			<span className="bn-glass-strong shadow-bn-elev flex items-center gap-2.5 whitespace-nowrap rounded-bn-pill px-6 py-3 text-bn-lg font-bold text-bn-text-primary">
				<span className="grid h-7 w-7 place-items-center rounded-full bg-bn-success-text text-bn-base text-bn-on-solid">
					✓
				</span>
				{text}
			</span>
		</div>,
		document.body,
	);
}

interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	color: string;
}

// 主粉运行时从主题 token 读(跟皮肤走),其余是 canvas 专属的装饰配色
const FIREWORK_EXTRA_COLORS = ["#ffd166", "#8be9fd", "#ffffff"];
const FIREWORK_DURATION_MS = 3200;

/**
 * 毕业烟花:全屏透明 canvas,分批在上半屏炸开粒子(重力+衰减+短尾线),
 * 演完 onDone 自卸。jsdom 没有 2d context → 不画,只按时长空转(测试仍能
 * 断言容器存在);prefers-reduced-motion → 整场直接跳过。
 */
export function Fireworks({ onDone }: { onDone: () => void }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	useEffect(() => {
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			onDoneRef.current();
			return;
		}
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext?.("2d") ?? null;
		const endTimer = setTimeout(() => onDoneRef.current(), FIREWORK_DURATION_MS);
		if (!canvas || !ctx) return () => clearTimeout(endTimer);

		// 视口尺寸每帧现取:只在挂载时量一次的话,演出中途转屏/改窗口就会让 canvas
		// 的位图停在旧尺寸被 CSS 拉伸(炸点偏移、clearRect 清不干净留下拖影)。
		let w = window.innerWidth;
		let h = window.innerHeight;
		// 已经落到位图上的尺寸。拿它比而不是比 canvas.width:后者出厂是 300×150,
		// 万一视口正好是这个数,首帧就被当成「没变」跳过,矩阵与线宽一次都没落。
		let fittedW = -1;
		let fittedH = -1;
		const fitCanvas = () => {
			const dpr = window.devicePixelRatio || 1;
			w = window.innerWidth;
			h = window.innerHeight;
			const px = w * dpr;
			const py = h * dpr;
			// 尺寸没变就别碰 —— 给 canvas.width 赋值会重新分配整块位图并清空它
			// (2560×1440@2x ≈ 59MB),而拖动窗口时 resize 一秒能来几十发。
			if (px === fittedW && py === fittedH) return;
			fittedW = px;
			fittedH = py;
			canvas.width = px;
			canvas.height = py;
			// 尺寸一改 canvas 的变换矩阵就复位了,scale 每次都要重新落。
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.lineWidth = 2; // 同样被复位,粒子循环里不再逐颗设
		};
		fitCanvas();
		window.addEventListener("resize", fitCanvas);

		const themePink = getComputedStyle(document.documentElement)
			.getPropertyValue("--color-bn-pink")
			.trim();
		const colors = [themePink || "#ff7eb6", ...FIREWORK_EXTRA_COLORS];
		const particles: Particle[] = [];
		const burst = () => {
			const cx = w * (0.2 + Math.random() * 0.6);
			const cy = h * (0.18 + Math.random() * 0.3);
			const color = colors[Math.floor(Math.random() * colors.length)];
			const count = 42 + Math.floor(Math.random() * 20);
			for (let i = 0; i < count; i++) {
				const angle = (Math.PI * 2 * i) / count + Math.random() * 0.2;
				const speed = 2.2 + Math.random() * 3.2;
				particles.push({
					x: cx,
					y: cy,
					vx: Math.cos(angle) * speed,
					vy: Math.sin(angle) * speed,
					life: 1,
					color,
				});
			}
		};
		const burstTimers = [0, 350, 750, 1200, 1700, 2100].map((ms) => setTimeout(burst, ms));

		let raf = 0;
		const frame = () => {
			ctx.clearRect(0, 0, w, h);
			// 一发烟花的粒子同色且连续入队,所以照数组顺序走下来颜色是成段的 ——
			// 记住上一次设的值,strokeStyle 的赋值(每次都要解析一遍颜色字符串)
			// 就从每帧两百来次降到每帧几次。
			let stroke = "";
			for (const p of particles) {
				if (p.life <= 0) continue;
				const px = p.x;
				const py = p.y;
				p.x += p.vx;
				p.y += p.vy;
				p.vy += 0.055; // 重力
				p.vx *= 0.985;
				p.vy *= 0.985;
				p.life -= 0.012;
				ctx.globalAlpha = Math.max(0, p.life);
				if (p.color !== stroke) {
					stroke = p.color;
					ctx.strokeStyle = stroke;
				}
				ctx.beginPath();
				ctx.moveTo(px, py);
				ctx.lineTo(p.x, p.y);
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);

		return () => {
			clearTimeout(endTimer);
			for (const t of burstTimers) clearTimeout(t);
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", fitCanvas);
		};
	}, []);

	return createPortal(
		<canvas
			ref={canvasRef}
			data-testid="tour-fireworks"
			aria-hidden
			className="pointer-events-none fixed inset-0 z-bn-tour-panel h-full w-full"
		/>,
		document.body,
	);
}
