/**
 * AI 服务商的标识图形。
 *
 * **这些是手绘的简化标记,不是各家的官方 LOGO 文件。** 刻意如此:dashboard 要能
 * 完全离线跑,不去公网拉图;而把官方 LOGO 位图内联进 bundle 既臃肿又牵扯商标。
 * 这里只求「一眼能认出是哪家」——品牌主色 + 一个能对上号的几何轮廓。
 *
 * 想换成官方矢量图的话,把对应 `<svg>` 的内容替换掉即可,外面那层 tile 不用动。
 */

import type { AIProviderId } from "@bilibili-notify/internal/constants";

export interface ProviderBrand {
	/** 品牌主色,同时用于图形描边与 tile 的低透明度底色。 */
	color: string;
	glyph: React.ReactNode;
}

const stroke = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.7,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

/** 每家一条。`Record<AIProviderId, …>` 是有意的 —— 注册表加一家而这里忘了画,编译期就会红。 */
export const PROVIDER_BRANDS: Record<AIProviderId, ProviderBrand> = {
	// 路由分发:一个入口分叉到多个下游节点。
	openrouter: {
		color: "#8b8b9e",
		glyph: (
			<>
				<path {...stroke} d="M3 12h5" />
				<path {...stroke} d="M8 12c3 0 3-6 6-6h4" />
				<path {...stroke} d="M8 12c3 0 3 6 6 6h4" />
				<circle {...stroke} cx="19.5" cy="6" r="1.8" />
				<circle {...stroke} cx="19.5" cy="18" r="1.8" />
				<circle {...stroke} cx="3" cy="12" r="1.3" />
			</>
		),
	},
	// 火山:山形轮廓 + 喷出的火星。
	volcengine: {
		color: "#1664ff",
		glyph: (
			<>
				<path {...stroke} d="M3.5 19.5h17L14.6 9.2h-5.2z" />
				<path {...stroke} d="M9.6 9.2 12 4.5l2.4 4.7" />
				<path {...stroke} d="M17.6 5.6 19 4.2M6.4 5.6 5 4.2" />
			</>
		),
	},
	// 流动:三道错开的水平流线。
	siliconflow: {
		color: "#7c5cff",
		glyph: (
			<>
				<path {...stroke} d="M3 8c3.5-2.5 6.5 2.5 10 0s6.5 2.5 8 1.2" />
				<path {...stroke} d="M3 13c3.5-2.5 6.5 2.5 10 0s6.5 2.5 8 1.2" />
				<path {...stroke} d="M3 18c3.5-2.5 6.5 2.5 10 0s6.5 2.5 8 1.2" />
			</>
		),
	},
	// 鲸鱼:身子 + 尾鳍 + 一柱水花。
	deepseek: {
		color: "#4d6bfe",
		glyph: (
			<>
				<path
					{...stroke}
					d="M3 14.5c0-3 2.4-5.5 5.4-5.5h3.8c3.2 0 5.8 2.6 5.8 5.8 0 1.5-1.2 2.7-2.7 2.7H5.7A2.7 2.7 0 0 1 3 14.8z"
				/>
				<path {...stroke} d="m18.6 12.4 2.9-2v6.2l-2.6-1.8" />
				<path {...stroke} d="M9 6.2c0-1 .8-1.8 1.8-1.8" />
				<circle cx="7.4" cy="13" r="1" fill="currentColor" />
			</>
		),
	},
	// 兜底:一组可自由拨动的滑杆。
	custom: {
		color: "#94a3b8",
		glyph: (
			<>
				<path {...stroke} d="M5 7h14M5 12h14M5 17h14" />
				<circle {...stroke} cx="9" cy="7" r="2" />
				<circle {...stroke} cx="15" cy="12" r="2" />
				<circle {...stroke} cx="8" cy="17" r="2" />
			</>
		),
	},
};

/** 单个服务商的方形标识。`size` 是外框边长。 */
export function ProviderLogo({ id, size = 26 }: { id: AIProviderId; size?: number }) {
	const brand = PROVIDER_BRANDS[id];
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			role="presentation"
			aria-hidden="true"
			style={{ color: brand.color }}
		>
			{brand.glyph}
		</svg>
	);
}
