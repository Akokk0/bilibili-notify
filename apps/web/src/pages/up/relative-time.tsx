import { useMinuteClock } from "../../hooks/useMinuteClock";
import { relativeTime } from "./helpers";

/**
 * 挂在页面上的「N 分钟前」—— 跟着全面板共用的分钟节拍走(`useMinuteClock`)。只在渲染那一刻算
 * 一次的话,页面开着不动,它就一直停在「刚刚」。
 *
 * **单独一个组件**:每拍只重画这几个字,不带着整行 / 整张卡重画;也只有真画了时间的地方才订
 * 节拍,一处时间都没有的页不起定时器。
 */
export function RelativeTime({ at }: { at: string | number | undefined }) {
	const now = useMinuteClock();
	return <>{relativeTime(at, now)}</>;
}
