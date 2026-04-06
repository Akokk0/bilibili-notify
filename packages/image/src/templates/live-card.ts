export type LiveCardParams = {
	font: string;
	removeBorder: boolean;
	hideDesc: boolean;
	followerDisplay: boolean;
	// 颜色
	cardColorStart: string;
	cardColorEnd: string;
	cardBasePlateColor: string;
	cardBasePlateBorder: string;
	// 直播数据
	// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
	data: any;
	username: string;
	userface: string;
	titleStatus: string;
	liveTime: string;
	liveStatus: number;
	cover: boolean;
	onlineNum: string;
	likedNum: string;
	watchedNum: string;
	fansNum: string;
	fansChanged: string;
};

export function buildLiveCardHtml(p: LiveCardParams): string {
	return /* html */ `
        <!DOCTYPE html>
        <html>
        <head>
            <title>直播通知</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                    font-family: "${p.font}", "Microsoft YaHei", "Source Han Sans", "Noto Sans CJK", sans-serif;
                }

                html {
                    width: 800px;
                    height: auto;
                }

                .background {
                    width: 100%;
                    height: auto;
                    padding: 15px;
                    background: linear-gradient(to right bottom, ${p.cardColorStart}, ${p.cardColorEnd});
                    overflow: hidden;
                }

                .base-plate {
                    width: 100%;
                    height: auto;
                    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2);
                    padding: ${p.cardBasePlateBorder};
                    border-radius: 10px;
                    background-color: ${p.cardBasePlateColor};
                }

                .card {
                    width: 100%;
                    height: auto;
                    border-radius: 5px;
                    padding: 15px;
                    overflow: hidden;
                    background-color: #fff;
                }

                .card img {
                    border-radius: 5px 5px 0 0;
                    max-width: 100%;
                    max-height: 80%;
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-top: 5px;
                    margin-bottom: 10px;
                }

                .card-title {
                    line-height: 50px;
                }

                .card-body {
                    padding: 2px 16px;
                    margin-bottom: 10px;
                }

                .live-broadcast-info {
                    display: flex;
                    align-items: center;
                    margin-bottom: 10px;
                }

                .anchor-avatar {
                    width: 50px;
                    height: auto;
                    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2);
                }

                .broadcast-message {
                    display: inline-block;
                    margin-left: 10px;
                    font-size: 20px;
                    color: #333;
                }

                .card-text {
                    color: grey;
                    font-size: 20px;
                }

                .card-link {
                    display: flex;
                    justify-content: space-between;
                    text-decoration: none;
                    font-size: 20px;
                    margin-top: 10px;
                    margin-bottom: 10px;
                }
            </style>
        </head>
        <body>
            <div class="background">
                <div ${p.removeBorder ? "" : 'class="base-plate"'}>
                    <div class="card">
                        <img src="${p.cover ? p.data.user_cover : p.data.keyframe}" alt="封面">
                        <div class="card-body">
                            <div class="card-header">
                                <h1 class="card-title">${p.data.title}</h1>
                                <div class="live-broadcast-info">
                                    <img style="border-radius: 10px; margin-left: 10px" class="anchor-avatar"
                                        src="${p.userface}" alt="主播头像">
                                    <span class="broadcast-message">${p.username}${p.titleStatus}</span>
                                </div>
                            </div>
                            ${p.hideDesc ? "" : `<p class="card-text">${p.data.description ? p.data.description : "这个主播很懒，什么简介都没写"}</p>`}
                            <p class="card-link">
                                <span>${p.liveStatus === 3 ? `本场直播点赞数：${p.likedNum}` : `人气：${p.onlineNum}`}</span>
                                <span>分区名称：${p.data.area_name}</span>
                            </p>
                            <p class="card-link">
                                <span>${p.liveTime}</span>
                                ${
																	p.followerDisplay
																		? `
                                <span>
                                ${
																	p.liveStatus === 1
																		? `当前粉丝数：${p.fansNum || "暂未获取到"}`
																		: p.liveStatus === 2
																			? `${p.watchedNum !== "API" ? `累计观看人数：${p.watchedNum}` : ""}`
																			: p.liveStatus === 3
																				? `粉丝数变化：${p.fansChanged}`
																				: ""
																}
                                </span>`
																		: ""
																}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `;
}
