import { GuardLevel } from "blive-message-listener";

export const CARD_SIZES = {
	large: {
		avatarSize: "70px",
		upNameFont: "27px",
		pubTimeFont: "20px",
		dressUpFont: "17px",
		cardDetailsFont: "22px",
		forwardUserinfoHeight: "35px",
		forwardUsernameFont: "20px",
		forwardAvatarSize: "25px",
		videoCardHeight: "147px",
		dynTitleFont: "20px",
		upInfoHeight: "70px",
		dynamicCardRight: "67px",
		dynamicCardTop: "24px",
	},
	normal: {
		avatarSize: "50px",
		upNameFont: "20px",
		pubTimeFont: "12px",
		dressUpFont: "12px",
		cardDetailsFont: "14px",
		forwardUserinfoHeight: "30px",
		forwardUsernameFont: "15px",
		forwardAvatarSize: "20px",
		videoCardHeight: "132px",
		dynTitleFont: "20px",
		upInfoHeight: "50px",
		dynamicCardRight: "37px",
		dynamicCardTop: "5px",
	},
} as const;

export const BG_COLORS: Record<GuardLevel, [string, string]> = {
	[GuardLevel.None]: ["#4ebcec", "#F9CCDF"],
	[GuardLevel.Jianzhang]: ["#4ebcec", "#b494e5"],
	[GuardLevel.Tidu]: ["#d8a0e6", "#b494e5"],
	[GuardLevel.Zongdu]: ["#f2a053", "#ef5f5f"],
};

export const SC_LEVELS = {
	Level1: { battery: 300, duration: "60秒", price: 30 },
	Level2: { battery: 500, duration: "2分钟", price: 50 },
	Level3: { battery: 1000, duration: "5分钟", price: 100 },
	Level4: { battery: 5000, duration: "30分钟", price: 500 },
	Level5: { battery: 10000, duration: "1小时", price: 1000 },
	Level6: { battery: 20000, duration: "2小时", price: 2000 },
} as const;

export const SC_COLORS = [
	["#a8e6cf", "#88d8b0"], // Level1 清新绿
	["#74b9ff", "#0984e3"], // Level2 天空蓝
	["#a29bfe", "#6c5ce7"], // Level3 梦幻紫
	["#fd79a8", "#e84393"], // Level4 热情粉
	["#fdcb6e", "#e17055"], // Level5 荣耀金
	["#ff7675", "#d63031"], // Level6 传说红
] as const;

export function getSCLevel(battery: number): number {
	if (battery >= 20000) return 5;
	if (battery >= 10000) return 4;
	if (battery >= 5000) return 3;
	if (battery >= 1000) return 2;
	if (battery >= 500) return 1;
	return 0;
}

export function generateDynamicCardStyle(
	font: string,
	isLargeFont: boolean,
	cardColorStart: string,
	cardColorEnd: string,
	cardBasePlateBorder: string,
	cardBasePlateColor: string,
	dynamicCardColor: string,
): string {
	const s = isLargeFont ? CARD_SIZES.large : CARD_SIZES.normal;
	return `
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: "${font}", "Microsoft YaHei", "Source Han Sans", "Noto Sans CJK", sans-serif;
            }

            html {
                width: 800px;
                height: auto;
            }

            .background {
                width: 100%;
                height: auto;
                padding: 15px;
                background: linear-gradient(to right bottom, ${cardColorStart}, ${cardColorEnd});
                overflow: hidden;
            }

            .base-plate {
                width: 100%;
                height: auto;
                box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2);
                padding: ${cardBasePlateBorder};
                border-radius: 10px;
                background-color: ${cardBasePlateColor};
            }

            .card {
                width: 100%;
                height: auto;
                border-radius: 5px;
                padding: 15px;
                overflow: hidden;
                background-color: #fff;
            }

            .card-body {
                display: flex;
                padding: 15px;
            }

            .card .anchor-avatar {
                max-width: ${s.avatarSize};
                max-height: ${s.avatarSize};
                margin-right: 20px;
                border-radius: 10px;
            }

            .card .card-body .card-content {
                width: 100%;
            }

            .card .card-body .card-content .card-header {
                width: 100%;
                display: flex;
                justify-content: space-between;
            }

            .card .up-info {
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                height: ${s.upInfoHeight};
            }

            .card .up-info .up-name {
                font-size: ${s.upNameFont};
            }

            .card .pub-time {
                font-size: ${s.pubTimeFont};
                color: grey;
            }

            .card .card-header img {
                height: 50px;
            }

            .card .dress-up {
                position: relative;
                font-size: ${s.dressUpFont};
            }

            .card .dress-up img {
                max-width: 100%;
                max-height: 100%;
            }

            .card .dress-up span {
                position: absolute;
                color: ${dynamicCardColor};
                right: ${s.dynamicCardRight};
                top: ${s.dynamicCardTop};
            }

            .card .dyn-title {
                font-size: ${s.dynTitleFont};
                margin-bottom: 10px;
            }

            .card .card-topic {
                display: flex;
                align-items: center;
                margin-top: 10px;
                font-size: 20px;
                color: #008AC5;
                gap: 3px;
            }

            .card .card-details {
                margin-top: 5px;
                margin-bottom: 15px;
                font-size: ${s.cardDetailsFont};
                width: 90%;
            }

            .card .card-major {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
            }

            .card .card-major .photo-item {
                border-radius: 10px;
                overflow: hidden;
                width: 170px;
                height: 170px;
                object-fit: cover;
            }

            .card .card-major .single-photo-mask {
                position: absolute;
                text-align: center;
                width: 100%;
                height: 100%;
                top: 0;
                left: 0;
                background: linear-gradient(to top, rgba(0, 0, 0, 0.9) 0%, transparent 30%);
            }

            .card .card-major .single-photo-mask-text {
                position: absolute;
                color: #fff;
                font-size: 24px;
                right: 0;
                bottom: 66px;
                left: 0;
                text-align: center;
            }

            .card .card-major .single-photo-mask-arrow {
                position: absolute;
                width: 70px;
                height: 70px;
                bottom: 7px;
                left: 50%;
                transform: translateX(-50%);
            }

            .card .card-major .single-photo-container {
                position: relative;
                max-width: 500px;
                max-height: 1000px;
                border-radius: 10px;
                overflow: hidden;
            }

            .card .card-major .single-photo-item {
                max-width: 500px;
                border-radius: 10px;
                overflow: hidden;
            }

            .card .card-major .four-photo-item {
                width: 170px;
                height: 170px;
                object-fit: cover;
                border-radius: 10px;
                overflow: hidden;
                flex-basis: 20%;
            }

            .card .card-stat {
                display: flex;
                justify-content: space-between;
                width: 90%;
                margin-top: 15px;
                color: gray;
                font-size: 14px;
            }

            .card .card-stat .stat-item {
                display: flex;
                align-items: center;
                gap: 3px;
            }

            .card .card-video {
                display: flex;
                overflow: hidden;
                border-radius: 5px 0 0 5px;
                margin-top: 10px;
                height: ${s.videoCardHeight};
            }

            .card .video-cover {
                position: relative;
                flex: 2;
                overflow: hidden;
            }

            .card .video-cover img {
                width: 236px;
            }

            .card .cover-mask {
                position: absolute;
                width: 100%;
                height: 100%;
                top: 0;
                left: 0;
                background: linear-gradient(to top, rgba(0, 0, 0, 0.5) 0%, transparent 30%);
            }

            .card .video-cover span {
                position: absolute;
                color: #fff;
                font-size: 14px;
                right: 10px;
                bottom: 8px;
            }

            .card .video-info {
                display: flex;
                justify-content: space-between;
                flex-direction: column;
                flex: 3;
                border: #e5e7e9 1px solid;
                border-left: none;
                border-radius: 0 5px 5px 0;
                padding: 12px 16px 10px;
                background-color: #fff;
            }

            .card .video-info-header .video-title {
                font-size: 16px;
            }

            .card .video-info-header .video-introduction {
                margin-top: 5px;
                font-size: 12px;
                color: #AAA;
                display: -webkit-box;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 2;
                overflow: hidden;
            }

            .card .video-stat {
                font-size: 12px;
                color: #AAA;
                display: flex;
                gap: 35px
            }

            .card .video-stat .video-stat-item {
                display: flex;
                align-items: center;
                gap: 3px;
            }

            .card .card-forward {
                border-radius: 5px;
                padding: 12px 10px 14px 10px;
                background-color: #F6F7F8;
            }

            .card-forward .forward-userinfo {
                display: flex;
                align-items: center;
                gap: 5px;
                height: ${s.forwardUserinfoHeight};
            }

            .forward-userinfo img {
                width: ${s.forwardAvatarSize};
                height: ${s.forwardAvatarSize};
                border-radius: 50%;
            }

            .forward-userinfo span {
                color: #61666D;
                font-size: ${s.forwardUsernameFont};
            }

            .card .card-reserve {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 20px 10px 20px;
                margin-top: 10px;
                border-radius: 10px;
                background-color: #F6F7F8;
            }

            .up-recommand {
                margin-top: 10px;
                font-size: 14px;
                color: #9499A0;
            }

            .card-reserve .reserve-title {
                font-size: 14px;
                color: #18191C;
            }

            .card-reserve .reserve-desc {
                margin-top: 7px;
                font-size: 12px;
                color: #9499A0;
            }

            .reserve-info .reserve-time {
                margin-right: 7px;
            }

            .card-reserve .reserve-prize {
                display: flex;
                align-items: center;
                margin-top: 3px;
                gap: 3px;
                color: #00AEEC;
            }

            .card .card-reserve .reserve-button button {
                border: none;
                height: 30px;
                width: 72px;
                font-size: 13px;
                border-radius: 7px;
            }

            .card .card-reserve .reserve-button .reserve-button-end {
                display: flex;
                align-items: center;
                justify-content: center;
                color: #9499A0;
                background-color: #E3E5E7;
            }

            .card .card-reserve .reserve-button .reserve-button-ing {
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFF;
                background-color: #00A0D8;
            }

            .card .goods-header {
                font-size: 14px;
                color: #18191C;
                margin-top: 10px;
                margin-bottom: 8px;
            }

            .card .goods-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .card .goods-item {
                display: flex;
                align-items: center;
                padding: 10px;
                background-color: #fff;
                border-radius: 8px;
                border: 1px solid #e5e7e9;
                gap: 12px;
            }

            .card .goods-cover {
                width: 80px;
                height: 80px;
                flex-shrink: 0;
                border-radius: 6px;
                overflow: hidden;
                background-color: #f0f0f0;
            }

            .card .goods-cover img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .card .goods-content {
                flex: 1;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                min-width: 0;
            }

            .card .goods-name {
                font-size: 14px;
                color: #18191C;
                display: -webkit-box;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 2;
                overflow: hidden;
                line-height: 1.4;
            }

            .card .goods-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 6px;
            }

            .card .goods-price {
                font-size: 16px;
                color: #FF6699;
                font-weight: bold;
            }

            .card .goods-button {
                border: none;
                padding: 5px 14px;
                background-color: #00AEEC;
                color: #fff;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
            }
	`;
}
