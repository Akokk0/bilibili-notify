/// Custom desktop menus follow the OS language, independently of the host settings.
pub(super) struct MenuItemContent {
    pub id: &'static str,
    pub label: &'static str,
    pub accelerator: Option<&'static str>,
}

pub(super) struct MenuContent {
    pub actions: [MenuItemContent; 7],
    pub quit: MenuItemContent,
    // These custom application-menu entries are used only on macOS.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub about: MenuItemContent,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub edit_title: &'static str,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub window_title: &'static str,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub actions_title: &'static str,
}

pub(super) fn menu_content(system_locale: Option<&str>) -> MenuContent {
    let locale = system_locale
        .unwrap_or_default()
        .replace('_', "-")
        .to_lowercase();
    let tag = locale.split(['.', '@']).next().unwrap_or_default();
    let parts: Vec<_> = tag.split('-').collect();
    let language = parts.first().copied().unwrap_or_default();
    // An explicit script takes precedence over the region, as in zh-Hans-TW.
    let traditional = !parts.contains(&"hans")
        && parts
            .iter()
            .any(|part| matches!(*part, "hant" | "tw" | "hk" | "mo"));
    let simplified = language == "zh" && !traditional;
    let (labels, quit, about, edit_title, window_title, actions_title) = if language == "ja" {
        (
            [
                "ウィンドウを表示/非表示",
                "ブラウザーでパネルを開く",
                "サービスを再起動",
                "データフォルダーを開く",
                "サーバーログを開く",
                "ランチャーログを開く",
                "Dockアイコンを非表示/表示",
            ],
            "終了",
            "Bilibili Notify Desktopについて",
            "編集",
            "ウィンドウ",
            "操作",
        )
    } else if language == "zh" && traditional {
        (
            [
                "顯示/隱藏視窗",
                "在瀏覽器開啟面板",
                "重新啟動服務",
                "開啟資料目錄",
                "開啟伺服器日誌",
                "開啟啟動器日誌",
                "隱藏/顯示 Dock 圖示",
            ],
            "結束應用程式",
            "關於 Bilibili Notify Desktop",
            "編輯",
            "視窗",
            "操作",
        )
    } else if simplified {
        (
            [
                "显示/隐藏窗口",
                "用浏览器打开面板",
                "重启服务",
                "打开数据目录",
                "打开后端日志目录",
                "打开启动器日志目录",
                "隐藏/显示 Dock 图标",
            ],
            "退出应用",
            "关于 Bilibili Notify Desktop",
            "编辑",
            "窗口",
            "操作",
        )
    } else {
        (
            [
                "Show/Hide Window",
                "Open Panel in Browser",
                "Restart Service",
                "Open Data Folder",
                "Open Server Logs",
                "Open Launcher Logs",
                "Hide/Show Dock Icon",
            ],
            "Quit",
            "About Bilibili Notify Desktop",
            "Edit",
            "Window",
            "Actions",
        )
    };
    let ids = [
        "show_window",
        "open_dashboard",
        "restart_service",
        "open_data_dir",
        "open_server_log_dir",
        "open_launcher_log_dir",
        "toggle_dock",
    ];
    MenuContent {
        actions: std::array::from_fn(|index| MenuItemContent {
            id: ids[index],
            label: labels[index],
            accelerator: None,
        }),
        quit: MenuItemContent {
            id: "quit_app",
            label: quit,
            accelerator: Some("CmdOrCtrl+Q"),
        },
        about: MenuItemContent {
            id: "show_about",
            label: about,
            accelerator: None,
        },
        edit_title,
        window_title,
        actions_title,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_chinese_and_english_menu_content_is_preserved() {
        for locale in ["zh", "zh-CN", "zh-Hans", "zh-SG"] {
            let menu = menu_content(Some(locale));
            assert_eq!(
                menu.actions.map(|item| item.label),
                [
                    "显示/隐藏窗口",
                    "用浏览器打开面板",
                    "重启服务",
                    "打开数据目录",
                    "打开后端日志目录",
                    "打开启动器日志目录",
                    "隐藏/显示 Dock 图标"
                ]
            );
            assert_eq!(
                (
                    menu.quit.label,
                    menu.about.label,
                    menu.edit_title,
                    menu.window_title,
                    menu.actions_title
                ),
                (
                    "退出应用",
                    "关于 Bilibili Notify Desktop",
                    "编辑",
                    "窗口",
                    "操作"
                )
            );
        }
        let menu = menu_content(Some("en-US"));
        assert_eq!(
            menu.actions.map(|item| item.label),
            [
                "Show/Hide Window",
                "Open Panel in Browser",
                "Restart Service",
                "Open Data Folder",
                "Open Server Logs",
                "Open Launcher Logs",
                "Hide/Show Dock Icon"
            ]
        );
        assert_eq!(
            (
                menu.quit.label,
                menu.about.label,
                menu.edit_title,
                menu.window_title,
                menu.actions_title
            ),
            (
                "Quit",
                "About Bilibili Notify Desktop",
                "Edit",
                "Window",
                "Actions"
            )
        );
    }

    #[test]
    fn japanese_and_taiwan_chinese_menus_are_localized() {
        for locale in ["ja", "ja-JP"] {
            let menu = menu_content(Some(locale));
            assert_eq!(
                menu.actions.map(|item| item.label),
                [
                    "ウィンドウを表示/非表示",
                    "ブラウザーでパネルを開く",
                    "サービスを再起動",
                    "データフォルダーを開く",
                    "サーバーログを開く",
                    "ランチャーログを開く",
                    "Dockアイコンを非表示/表示"
                ]
            );
            assert_eq!(
                (
                    menu.quit.label,
                    menu.about.label,
                    menu.edit_title,
                    menu.window_title,
                    menu.actions_title
                ),
                (
                    "終了",
                    "Bilibili Notify Desktopについて",
                    "編集",
                    "ウィンドウ",
                    "操作"
                )
            );
        }
        for locale in ["zh-TW", "zh-Hant", "zh-HK", "zh-MO"] {
            let menu = menu_content(Some(locale));
            assert_eq!(
                menu.actions.map(|item| item.label),
                [
                    "顯示/隱藏視窗",
                    "在瀏覽器開啟面板",
                    "重新啟動服務",
                    "開啟資料目錄",
                    "開啟伺服器日誌",
                    "開啟啟動器日誌",
                    "隱藏/顯示 Dock 圖示"
                ]
            );
            assert_eq!(
                (
                    menu.quit.label,
                    menu.about.label,
                    menu.edit_title,
                    menu.window_title,
                    menu.actions_title
                ),
                (
                    "結束應用程式",
                    "關於 Bilibili Notify Desktop",
                    "編輯",
                    "視窗",
                    "操作"
                )
            );
        }
    }

    #[test]
    fn system_locale_variants_and_unknown_languages_resolve_without_host_settings() {
        for (locale, expected) in [
            (Some("JA_jp.UTF-8"), "終了"),
            (Some("zh_Hant_CN"), "結束應用程式"),
            (Some("zh-Hans-TW"), "退出应用"),
            (Some("zh_TW.UTF-8"), "結束應用程式"),
            (Some("en-GB"), "Quit"),
            (Some("fr-FR"), "Quit"),
            (Some("java"), "Quit"),
            (Some(""), "Quit"),
            (None, "Quit"),
        ] {
            assert_eq!(menu_content(locale).quit.label, expected, "{locale:?}");
        }
    }

    #[test]
    fn menu_action_order_ids_and_shortcuts_are_preserved() {
        for locale in [
            Some("zh-CN"),
            Some("en-US"),
            Some("ja-JP"),
            Some("zh-TW"),
            None,
            Some("fr-FR"),
        ] {
            let menu = menu_content(locale);
            assert_eq!(
                menu.actions.map(|item| (item.id, item.accelerator)),
                [
                    ("show_window", None),
                    ("open_dashboard", None),
                    ("restart_service", None),
                    ("open_data_dir", None),
                    ("open_server_log_dir", None),
                    ("open_launcher_log_dir", None),
                    ("toggle_dock", None)
                ]
            );
            assert_eq!(
                (menu.quit.id, menu.quit.accelerator),
                ("quit_app", Some("CmdOrCtrl+Q"))
            );
            assert_eq!(
                (menu.about.id, menu.about.accelerator),
                ("show_about", None)
            );
        }
    }
}
