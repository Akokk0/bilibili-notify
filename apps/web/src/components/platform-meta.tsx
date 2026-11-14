/** 适配器描述与连接快照提供外观;组件库只负责画。 */
import type { AdapterEntry, ConnectionView } from "@bilibili-notify/contract";
import type { NewConnection, PlatformSnapshot } from "@bilibili-notify/internal";
import {
	Icon,
	type IconName,
	PlatformIcon,
	type PlatformMeta,
	PlatformMetaProvider,
	usePlatformMeta,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { useAdapters } from "../hooks/useAdapters";
import { api } from "../services/api";
import { safeImage } from "../utils/settings-image";

function appearanceOf(
	descriptor: Pick<PlatformSnapshot, "color" | "shortLabel" | "icon">,
): PlatformMeta {
	const image = safeImage(descriptor.icon);
	return {
		tint: descriptor.color,
		label: descriptor.shortLabel,
		...(image
			? { image }
			: {
					icon:
						descriptor.icon && Object.hasOwn(Icon, descriptor.icon) ? descriptor.icon : undefined,
				}),
	};
}

/** 尚未保存的候选直接画自己的描述，不依赖全局连接快照。 */
export function DescriptorIcon({
	descriptor,
	size = 16,
	fallbackIcon,
	label,
	manifestSvg,
}: {
	descriptor: Pick<PlatformSnapshot, "color" | "shortLabel" | "icon">;
	size?: number;
	/** 只接受图形的摆放处指定兜底，缺省仍沿用平台短名。 */
	fallbackIcon?: IconName;
	/** 作为独立平台标识时提供完整名称，用于读屏和悬停提示。 */
	label?: string;
	/** 仅供宿主已用清单白名单核过的内联图形；不从普通描述符猜测 SVG。 */
	manifestSvg?: string;
}) {
	const meta = appearanceOf(descriptor);
	if (manifestSvg) meta.svg = manifestSvg;
	if (!meta.image && !meta.icon && !meta.svg && fallbackIcon) meta.icon = fallbackIcon;
	const icon = (
		<PlatformMetaProvider value={() => meta}>
			<PlatformIcon platform={descriptor.shortLabel} size={size} />
		</PlatformMetaProvider>
	);
	return label ? (
		<span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center">
			{icon}
		</span>
	) : (
		icon
	);
}

export function buildPlatformTable(
	adapters: readonly AdapterEntry[],
	connections: readonly ConnectionView[] = [],
): (platform: string) => PlatformMeta | undefined {
	const table = new Map<string, PlatformMeta>();
	for (const adapter of adapters) table.set(adapter.key, appearanceOf(adapter.descriptor));
	for (const connection of connections) {
		const meta = appearanceOf(connection.platformSnapshot);
		table.set(`connection:${connection.id}`, meta);
		table.set(connection.platform, meta);
	}
	return (platform) => table.get(platform);
}

export function useConnectionFace(): (
	connection: Pick<NewConnection, "adapterKey" | "platform"> & { id?: string },
) => string {
	const lookup = usePlatformMeta();
	return (connection) => {
		const key = `connection:${connection.id}`;
		return lookup(key) ? key : connection.adapterKey;
	};
}

export function PlatformMetaRoot({ children }: { children: ReactNode }) {
	const adapters = useAdapters();
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<ConnectionView[]>("/api/connections"),
		retry: false,
	});
	const lookup = useMemo(
		() => buildPlatformTable(adapters.data?.adapters ?? [], connections.data ?? []),
		[adapters.data, connections.data],
	);
	return <PlatformMetaProvider value={lookup}>{children}</PlatformMetaProvider>;
}
