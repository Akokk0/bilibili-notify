import { Btn, Icon } from "@bilibili-notify/ui";
import { useNavigate } from "react-router-dom";
import { useT } from "../../i18n";
import type { ResourceCategory } from "./library-data";
import { usePreserveResourceDrafts } from "./resource-drafts";

/** 用当前页面路由定位到对应分类，不提交选择窗中未确认的值。 */
export function ManageResourcesButton({
	category,
	label,
}: {
	category: ResourceCategory;
	label?: string;
}) {
	const t = useT();
	const navigate = useNavigate();
	const preserveDrafts = usePreserveResourceDrafts();
	return (
		<Btn
			size="sm"
			variant="outline"
			icon={<Icon.link size={14} />}
			title={t("library.manageResourcesHint")}
			onClick={() => {
				preserveDrafts();
				navigate(`/library?category=${category}`);
			}}
		>
			{label ?? t("library.manageResources")}
		</Btn>
	);
}
