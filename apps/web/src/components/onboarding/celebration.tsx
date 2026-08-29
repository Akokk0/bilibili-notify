import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * 导览的完成反馈件 —— 主步判据变绿的那一拍就地庆祝。
 *
 * - StepDoneBadge:屏幕中央弹出「✓ 完成」大胶囊(主人定案:挂操作位置太不
 *   起眼,居中放大才看得见),动画演完自卸 —— 不然小卡文案无声切到下一步,
 *   用户不知道刚才那步已经成了;
 * - Fireworks:五步全绿的毕业时刻,全屏 canvas 烟花放一场(prefers-reduced-motion
 *   时整场跳过)。指针事件全穿透,谁也不挡。
 */

/** 完成徽章:屏幕中央弹出,一段 keyframes 演完(onAnimationEnd)自卸。 */
export function StepDoneBadge({ text, onDone }: { text: string; onDone: () => void }) {
	return createPortal(
		<div
			data-testid="tour-done-badge"
			aria-hidden
			className="bn-tour-done pointer-events-none fixed left-1/2 top-1/2 z-bn-tour-panel"
			onAnimationEnd={onDone}
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

		const dpr = window.devicePixelRatio || 1;
		const w = window.innerWidth;
		const h = window.innerHeight;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		ctx.scale(dpr, dpr);

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
				ctx.strokeStyle = p.color;
				ctx.lineWidth = 2;
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
