/**
 * 拓展页上演动画的那一处 —— 照 `card-motion.ts` 那一格画:装完的传送、更新完的换装。
 *
 * 谁放进来的都一样(装拓展那个 hook、devtools 的「播放 × 动画」),演完只收自己那一段。
 */

import { useCardMotionStore } from "./card-motion";
import { InstallFlight } from "./install-flight";
import { UpdateFlight } from "./update-flight";

export function CardMotionStage() {
	const motion = useCardMotionStore((state) => state.motion);
	const clear = useCardMotionStore((state) => state.clear);
	const done = () => {
		if (motion) clear(motion);
	};
	return (
		<>
			<InstallFlight flight={motion?.kind === "install" ? motion : null} onDone={done} />
			<UpdateFlight motion={motion?.kind === "update" ? motion : null} onDone={done} />
		</>
	);
}
