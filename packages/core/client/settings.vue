<template>
  <div v-if="status === 'loading'" class="loading-wrapper">
    <div class="spinner"></div>
    <p>{{ dataServer.msg }}</p>
  </div>

  <k-comment v-if="status === 'not_login'" type="error">
    <div class="comment">
      <p>{{ dataServer.msg }}</p>
      <k-button @click="login">登录</k-button>
    </div>
  </k-comment>

  <k-comment v-if="status === 'logging_qr'" type="warning">
    <div v-if="qrcodeImg" class="comment">
      <p>请使用Bilibili App扫码登录</p>
      <img class="qrcode" :src="qrcodeImg" alt="qrcode" />
      <p>{{ dataServer.msg }}</p>
    </div>
    <div v-if="!qrcodeImg" class="comment">
      <p>二维码显示失败，请重新登录</p>
      <k-button @click="login">重新登录</k-button>
    </div>
  </k-comment>

  <k-comment v-if="status === 'login_failed'" type="error">
    <div class="comment">
      <p>{{ dataServer.msg }}</p>
      <k-button @click="login">重新登录</k-button>
    </div>
  </k-comment>

  <k-comment v-if="status === 'login_success'" type="success">
    <div class="comment">
      <p>{{ dataServer.msg }}</p>
      <k-button @click="restart">重启插件</k-button>
    </div>
  </k-comment>

  <template v-if="status === 'logged_in'">
    <k-comment type="warning" style="margin-bottom: 1rem">
      <div class="comment">
        <p>重新登录：重新触发扫码流程，不清除已有密钥。</p>
        <p>重置密钥：清除已保存的 Cookie 和密钥，需要重新扫码登录。</p>
        <div style="display: flex; gap: 0.5rem">
          <k-button @click="login">重新登录</k-button>
          <k-button @click="resetKey">重置密钥</k-button>
        </div>
      </div>
    </k-comment>

    <div v-if="!isLoaded" class="loading-wrapper">
      <div class="spinner"></div>
      <p>正在加载登录账号信息中...</p>
      <div v-show="tips">
        <span>加载太久？可能是网络错误，可以尝试切换到其他插件页再切回来；加载不出来也不影响使用哦～</span>
      </div>
    </div>
    <div v-else class="logged-in fade-in">
      <div class="user-bg-wrapper">
        <img class="user-bg" :src="userBGImg" alt="user-bg" />
      </div>
      <div class="user-info">
        <img class="avatar" :src="avatarImg" alt="avatar" />
        <div class="name-sign">
          <div class="udesc">
            <span class="uname">{{ dataServer.data.card.name }}</span>
            <img v-if="dataServer.data.card.vip.vipStatus === 1" class="uvip" :src="vipImg" alt="vip" />
          </div>
          <span class="usign">{{ dataServer.data.card.sign }}</span>
        </div>
      </div>
      <div class="user-status">
        <div>
          <span>关注数</span>
          <span>{{ formatNumber(dataServer.data.card.attention) }}</span>
        </div>
        <div>
          <span>粉丝数</span>
          <span>{{ formatNumber(dataServer.data.card.fans) }}</span>
        </div>
        <div>
          <span>获赞数</span>
          <span>{{ formatNumber(dataServer.data.like_num) }}</span>
        </div>
      </div>
      <svg @click="login" class="logo" t="1645466458357" viewBox="0 0 2299 1024" version="1.1"
        xmlns="http://www.w3.org/2000/svg" p-id="2663" width="180" style="fill: var(--bew-theme-color);">
        <path
          d="M1775.840814 322.588002c6.0164 1.002733 53.144869-9.525967 55.150336-6.016401 3.0082 4.5123 24.065601 155.92504 18.550567 156.927774s-44.621635 10.027334-44.621635 10.027334c-3.0082-20.556034-28.577901-147.903173-29.079268-160.938707m75.205003-14.539634l20.556034 162.944174c10.5287-0.501367 53.144869-3.509567 57.155803-4.010934-6.0164-61.668103-16.545101-158.933241-16.545101-158.93324-20.054668-4.010934-41.112069-4.010934-61.166736 0m-40.610702 226.116376s92.752838-23.564234 126.344406-12.0328c17.046467 61.668103 48.131202 407.611118 51.139402 421.649386-21.057401 2.506833-90.246004 8.523234-95.761037 10.027333-4.5123-26.071068-81.72277-403.098818-81.722771-419.643919m343.436183-207.565809c5.515034 1.5041 54.648969-5.013667 55.150335-1.5041 1.002733 12.032801 6.0164 157.42914 0.501367 157.930507s-44.621635 4.010934-44.621635 4.010934c-1.002733-20.054668-12.032801-146.90044-11.030067-160.437341m75.70637-4.010933l4.010933 160.938707c10.5287 0 52.643502 2.506833 57.155803 2.005467-1.002733-61.668103 0-158.933241 0-158.933241-20.054668-3.509567-40.610702-5.013667-61.166736-4.010933m-64.676303 216.089043s94.758304-12.534167 126.845772 2.506833c7.019134 72.196803 6.0164 408.613852 7.019134 422.652119-21.558768 0-90.246004 1.002733-95.761038 2.005467-1.002733-26.071068-39.607968-410.619319-38.103868-427.164419m-220.099977-413.627519c54.648969 278.759879 96.262404 755.058234 97.766504 785.641602 0 0 43.117535 1.002733 91.750105 4.010934C2105.740095 614.383415 2070.644427 134.575493 2071.145794 119.033126c-12.032801-13.536901-126.344406 6.0164-126.344406 6.0164m-120.328005 659.297196c-10.5287-78.213204-290.291313-166.955108-447.720454-138.377206 0 0-19.553301-172.470141-27.073801-339.425248-6.517767-143.390873-1.002733-282.770813 0.501366-305.833681-10.5287-7.5205-123.837572 46.627102-185.004308 69.188603 0 0 73.199537 309.844614 126.344406 952.59671 0 0 84.730971 9.0246 230.12731-19.051934s317.365114-115.815705 302.825481-219.097244m-341.932083 140.88404l-24.566967-176.982441c6.0164-3.0082 156.927774 53.144869 172.971507 63.172203-2.506833 11.030067-148.40454 113.810238-148.40454 113.810238M610.664628 322.588002c6.0164 1.002733 53.144869-9.525967 55.150335-6.016401 3.0082 4.5123 24.065601 155.92504 18.550568 156.927774s-44.621635 10.027334-44.621635 10.027334c-3.0082-20.556034-28.577901-147.903173-29.079268-160.938707m75.205003-14.539634l20.556034 162.944174c10.5287-0.501367 53.144869-3.509567 57.155803-4.010934-6.517767-61.668103-16.545101-158.933241-16.545101-158.93324-20.054668-4.010934-41.112069-4.010934-61.166736 0m-40.610702 226.116376s92.752838-23.564234 126.344406-12.0328c17.046467 61.668103 48.131202 407.611118 51.139402 421.649386-21.057401 2.506833-90.246004 8.523234-95.761037 10.027333-4.5123-26.071068-81.72277-403.098818-81.722771-419.643919m343.436182-207.565809c5.515034 1.5041 54.648969-5.013667 55.150336-1.5041 1.002733 12.032801 6.0164 157.42914 0.501367 157.930507s-44.621635 4.010934-44.621635 4.010934c-1.002733-20.054668-11.531434-146.90044-11.030068-160.437341m75.706371-4.010933l4.010933 160.938707c10.5287 0 52.643502 2.506833 57.155803 2.005467-1.002733-61.668103 0-158.933241 0-158.933241-20.054668-3.509567-40.610702-4.5123-61.166736-4.010933m-64.676303 216.089043s94.758304-12.534167 126.845772 2.506833c7.019134 72.196803 6.0164 408.613852 7.019134 422.652119-21.558768 0-90.246004 1.002733-95.761038 2.005467-0.501367-26.071068-39.607968-410.619319-38.103868-427.164419m-220.099977-413.627519c54.648969 278.759879 96.262404 755.058234 97.766504 785.641602 0 0 43.117535 1.002733 91.750105 4.010934-28.577901-300.318647-63.67357-780.126569-63.172203-796.170303-12.032801-13.035534-126.344406 6.517767-126.344406 6.517767m-120.328005 659.297196c-10.5287-78.213204-290.291313-166.955108-447.720454-138.377206 0 0-19.553301-172.470141-27.073801-339.425248-6.517767-143.390873-1.002733-282.770813 0.501366-305.833681C174.475608-6.308547 61.166736 47.337689 0 69.89919c0 0 73.199537 309.844614 126.344406 952.59671 0 0 84.730971 9.0246 230.12731-19.051934s317.365114-115.815705 302.825481-219.097244m-341.932083 140.88404l-24.566967-176.982441c6.0164-3.0082 156.927774 53.144869 172.971507 63.172203-2.506833 11.030067-148.40454 113.810238-148.40454 113.810238"
          p-id="2664"></path>
      </svg>
    </div>
  </template>
</template>

<script lang="ts" setup>
/** biome-ignore-all lint/suspicious/noExplicitAny: <any required> */
import { send, store } from "@koishijs/client";
import { inject, ref, watch } from "vue";

enum BiliLoginStatus {
	NOT_LOGIN,
	LOADING_LOGIN_INFO,
	LOGIN_QR,
	LOGGING_QR,
	LOGGING_IN,
	LOGGED_IN,
	LOGIN_SUCCESS,
	LOGIN_FAILED,
}

type UserCardInfoData = {
	card: {
		mid: string;
		approve: boolean;
		name: string;
		sex: string;
		face: string;
		DisplayRank: string;
		regtime: number;
		spacesta: number;
		birthday: string;
		place: string;
		description: string;
		article: number;
		attention: number;
		sign: string;
		level_info: {
			current_level: number;
			current_min: number;
			current_exp: number;
			next_exp: number;
		};
		pendant: {
			pid: number;
			name: string;
			image: string;
			expire: number;
		};
		nameplate: {
			nid: number;
			name: string;
			image: string;
			image_small: string;
			level: string;
			condition: string;
		};
		Official: {
			role: number;
			title: string;
			desc: string;
			type: number;
		};
		official_verify: {
			type: number;
			desc: string;
		};
		vip: {
			vipType: number;
			dueRemark: string;
			accessStatus: number;
			vipStatus: number;
			vipStatusWarn: string;
			theme_type: number;
			label: {
				bg_color: string;
				bg_style: number;
				border_color: string;
				img_label_uri_hans: string;
				img_label_uri_hans_static: string;
				img_label_uri_hant: string;
				img_label_uri_hant_static: string;
				label_goto: {
					mobile: string;
					pc_web: string;
				};
				label_id: number;
				label_theme: string;
				path: string;
				text: string;
				text_color: string;
				use_img_label: boolean;
			};
		};
	};
	space: {
		s_img: string;
		l_img: string;
	};
	following: boolean;
	archive_count: number;
	article_count: number;
	follower: number;
	like_num: number;
};

const local: any = inject("manager.settings.local");

const avatarImg = ref("");
const userBGImg = ref("");
const vipImg = ref("");
const qrcodeImg = ref("");
const dataServer = ref({} as { status: BiliLoginStatus; msg: string; data: any });

const isLoaded = ref(false);

const status = ref("");
const tips = ref(false);

// 监听登录状态变化
watch(
	() => [store["bilibili-notify"].status, store["bilibili-notify"].msg],
	async () => {
		// 防止其他页面出现该内容
		if (local.value.name !== "koishi-plugin-bilibili-notify") return;
		// 赋值
		dataServer.value = store["bilibili-notify"];
		// 判断
		switch (store["bilibili-notify"].status) {
			case BiliLoginStatus.LOADING_LOGIN_INFO:
				status.value = "loading";
				return;
			case BiliLoginStatus.NOT_LOGIN:
				status.value = "not_login";
				return;
			case BiliLoginStatus.LOGGED_IN: {
				// 开启定时器
				const timer = setTimeout(() => {
					tips.value = true;
				}, 60000);
				// 获取数据
				const data = store["bilibili-notify"].data as UserCardInfoData;
				// 请求数据
				const requestCORS = async () => {
					await send("bilibili-notify/request-cors" as any, data.card.face).then(async (v) => {
						avatarImg.value = v;
					});
					await send("bilibili-notify/request-cors" as any, data.space.l_img).then(async (v) => {
						userBGImg.value = v;
					});
					await send(
						"bilibili-notify/request-cors" as any,
						data.card.vip.label.img_label_uri_hans_static,
					).then(async (v) => {
						vipImg.value = v;
					});
					// 清除定时器
					clearTimeout(timer);
					// 数据请求完毕，可以显示页面
					isLoaded.value = true;
				};
				// 设置状态
				status.value = "logged_in";
				// 请求CORS图片
				await requestCORS();
				// 结束
				return;
			}
			case BiliLoginStatus.LOGIN_QR:
				qrcodeImg.value = dataServer.value.data;
				status.value = "logging_qr";
				return;
			case BiliLoginStatus.LOGGING_QR:
				status.value = "logging_qr";
				return;
			case BiliLoginStatus.LOGGING_IN:
				status.value = "logging_in";
				return;
			case BiliLoginStatus.LOGIN_FAILED:
				status.value = "login_failed";
				return;
			case BiliLoginStatus.LOGIN_SUCCESS:
				status.value = "login_success";
				return;
		}
	},
	{ immediate: true },
);

// biome-ignore lint/correctness/noUnusedVariables: used in Vue template
const login = () => {
	send("bilibili-notify/start-login" as any);
};

// biome-ignore lint/correctness/noUnusedVariables: used in Vue template
const restart = () => {
	send("bilibili-notify/restart-plugin" as any);
};

// biome-ignore lint/correctness/noUnusedVariables: used in Vue template
const resetKey = () => {
	send("bilibili-notify/reset-key" as any);
};

// biome-ignore lint/correctness/noUnusedVariables: used in Vue template
const formatNumber = (num: number) => {
	if (num >= 1e8) {
		return `${(num / 1e8).toFixed(1).replace(/\.0$/, "")}亿`;
	} else if (num >= 1e4) {
		return `${(num / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
	} else {
		return num.toString();
	}
};
</script>

<style lang="scss">
:root {
  --bew-theme-color: #FB7299;
}

.comment {
  margin-bottom: 1rem;
}

.qrcode {
  width: 10rem;
  height: 10rem;
}

.loading-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: #888;

  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #ccc;
    border-top-color: var(--bew-theme-color);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 10px;
  }
}

.fade-in {
  opacity: 0;
  transform: translateY(10px);
  animation: fadeIn 0.5s forwards;
}

.logged-in {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 30rem;
  height: 8rem;
  border-radius: 1rem;
  padding: 1rem;
  margin-top: 1rem;
  margin-bottom: 1rem;
  overflow: hidden;
  box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(10px);

  .user-bg-wrapper {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 10rem;
    overflow: hidden;
    z-index: -1;
  }

  .user-bg {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .user-bg-wrapper::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0));
    pointer-events: none;
  }

  .user-bg::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0));
    pointer-events: none;
    z-index: 1;
  }

  .user-info {
    display: flex;
    gap: 1rem;

    .avatar {
      width: 5rem;
      height: 5rem;
      border-radius: 50%;
      border: 2px solid white;
    }

    .name-sign {
      display: flex;
      flex-direction: column;
      margin-top: 0.3rem;
      gap: 0.2rem;
      color: white;
      text-shadow: 3px 3px 5px rgba(0, 0, 0, 0.7);

      .udesc {
        display: flex;
        align-items: center;
        gap: 0.5rem;

        .uname {
          font-weight: 700;
          font-size: 1.7rem;
        }

        .uvip {
          width: 90px;
        }
      }

      .usign {
        font-weight: 700;
        font-size: 0.7rem;
      }
    }
  }

  .user-status {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
    color: white;
    font-size: 12px;
    font-weight: 700;
    text-shadow: 3px 3px 5px rgba(0, 0, 0, 0.7);

    div {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }

  }

  .logo {
    position: absolute;
    right: 1rem;
    bottom: 0.7rem;
    width: 5rem;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.15);
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

@keyframes fadeIn {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>