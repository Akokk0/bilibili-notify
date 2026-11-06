import { Btn, Icon } from "@bilibili-notify/ui";
import { useT } from "../../i18n";
import type { ResourceCategory } from "./library-data";

/** 保留原页草稿和选择窗暂存值，管理操作在独立页面进行。 */
export function ManageResourcesButton({ category }: { category: ResourceCategory }) {
	const t = useT();
	return (
		<Btn
			size="sm"
			variant="outline"
			icon={<Icon.link size={14} />}
			title={t("library.manageResourcesHint")}
			onClick={() => window.open(`/library?category=${category}`, "_blank", "noopener,noreferrer")}
		>
			{t("library.manageResources")}
		</Btn>
	);
}
