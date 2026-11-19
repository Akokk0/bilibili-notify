import type { AIProviderId } from "@bilibili-notify/internal/ai";
import { Icon } from "@bilibili-notify/ui";
import bailianLogo from "../assets/provider-logos/bailian.png";
import deepSeekLogo from "../assets/provider-logos/deepseek.svg";
import openRouterLogo from "../assets/provider-logos/openrouter.svg";
import openRouterDarkLogo from "../assets/provider-logos/openrouter-dark.svg";
import siliconFlowLogo from "../assets/provider-logos/siliconflow.svg";
import siliconFlowDarkLogo from "../assets/provider-logos/siliconflow-dark.svg";
import volcengineArkLogo from "../assets/provider-logos/volcengine-ark.svg";
import { useThemeStore } from "../store/theme";

interface ProviderBrand {
	color: string;
	logo?: string;
	darkLogo?: string;
}

/** 标识随面板打包。品牌图形用于指示服务商，保持源素材的颜色与比例。 */
export const PROVIDER_BRANDS: Record<AIProviderId, ProviderBrand> = {
	// 官方品牌素材中的 Grape 和 Cloud glyph。https://openrouter.ai/brand/
	openrouter: {
		color: "#7624f4",
		logo: openRouterLogo,
		darkLogo: openRouterDarkLogo,
	},
	// 火山方舟控制台的 arkIcon.svg。https://console.volcengine.com/ark
	volcengine: { color: "#006aff", logo: volcengineArkLogo },
	// 官方 Logo 资源包的单图形和反白版。https://www.siliconflow.cn/brand
	siliconflow: {
		color: "#6e29f6",
		logo: siliconFlowLogo,
		darkLogo: siliconFlowDarkLogo,
	},
	// 百炼控制台的 64 px favicon。https://bailian.console.aliyun.com/
	bailian: { color: "#663aff", logo: bailianLogo },
	// 官方资源目录的 ICON.svg。
	// https://github.com/deepseek-ai/awesome-deepseek-integration/tree/main/docs/_logo%20svg
	deepseek: { color: "#4d6bfe", logo: deepSeekLogo },
	custom: { color: "var(--color-bn-inactive)" },
};

export function ProviderLogo({
	id,
	size = 26,
	tone,
}: {
	id: AIProviderId;
	size?: number;
	/** 自定义服务商的通用图标可跟随选中色。 */
	tone?: string;
}) {
	const dark = useThemeStore((state) => state.resolved === "dark");
	const brand = PROVIDER_BRANDS[id];
	const logo = dark ? (brand.darkLogo ?? brand.logo) : brand.logo;
	if (!logo) return <Icon.sliders size={size} style={{ color: tone ?? brand.color }} />;
	return (
		<img
			src={logo}
			alt=""
			aria-hidden="true"
			width={size}
			height={size}
			className="block shrink-0 object-contain"
			style={{ width: size, height: size }}
		/>
	);
}
