use serde::Serialize;
use std::net::TcpListener;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::webview::{NewWindowResponse, PermissionResponse, WebviewBuilder};
use tauri::{LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewUrl};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBrowser {
    available: bool,
    endpoint: String,
    marker: String,
    #[serde(skip)]
    args: String,
}

fn trusted(caller: &Webview) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("此網頁無法控制應用程式。".into());
    }
    Ok(())
}

#[tauri::command]
async fn native_browser_info(
    caller: Webview,
    state: tauri::State<'_, NativeBrowser>,
) -> Result<NativeBrowser, String> {
    trusted(&caller)?;
    Ok(state.inner().clone())
}

#[tauri::command]
async fn native_browser_open(
    caller: Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeBrowser>,
) -> Result<NativeBrowser, String> {
    trusted(&caller)?;
    if !state.available {
        return Err("此系統的內嵌網頁尚未支援 CDP，請使用外置 Chromium 瀏覽器。".into());
    }
    if app.get_webview("browser").is_none() {
        let handle = app.clone();
        let marker = state.marker.clone();
        let builder = WebviewBuilder::new(
            "browser",
            WebviewUrl::External(state.marker.parse().map_err(|_| "內嵌網址不正確")?),
        )
        .additional_browser_args(&state.args)
        .focused(false)
        .on_navigation(move |url| {
            matches!(url.scheme(), "http" | "https") || url.as_str() == marker
        })
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https") {
                let app = handle.clone();
                std::thread::spawn(move || {
                    if let Some(view) = app.get_webview("browser") {
                        let _ = view.navigate(url);
                    }
                });
            }
            NewWindowResponse::Deny
        });
        let view = caller
            .window()
            .add_child(builder, LogicalPosition::new(0, 0), LogicalSize::new(1, 1))
            .map_err(|e| e.to_string())?;
        view.hide().map_err(|e| e.to_string())?;
    }
    let mut info = state.inner().clone();
    if let Some(view) = app.get_webview("browser") {
        info.marker = view.url().map_err(|e| e.to_string())?.to_string();
    }
    Ok(info)
}

#[tauri::command]
async fn native_browser_layout(
    caller: Webview,
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    trusted(&caller)?;
    let Some(view) = app.get_webview("browser") else {
        return Ok(());
    };
    if !visible {
        return view.hide().map_err(|e| e.to_string());
    }
    if ![x, y, width, height].iter().all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || width < 1.0
        || height < 1.0
    {
        return Err("內嵌網頁的位置不正確。".into());
    }
    let window = caller.window();
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    if x + width > size.width + 2.0 || y + height > size.height + 2.0 {
        return Err("內嵌網頁不可超出應用程式視窗。".into());
    }
    view.set_bounds(Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width, height).into(),
    })
    .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            drop(listener);
            let marker = format!(
                "about:blank#pilotry-{}",
                SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros()
            );
            let state = NativeBrowser {
                available: cfg!(target_os = "windows"),
                endpoint: format!("http://127.0.0.1:{port}"),
                marker,
                args: format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ),
            };
            let args = state.args.clone();
            app.manage(state);
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Pilotry")
                .inner_size(1360.0, 860.0)
                .min_inner_size(760.0, 560.0)
                .build()?;
            let main = WebviewBuilder::new("main", WebviewUrl::App("index.html".into()))
                .additional_browser_args(&args)
                .auto_resize()
                .on_navigation(|url| {
                    matches!(url.scheme(), "tauri")
                        || matches!(url.host_str(), Some("tauri.localhost"))
                        || (url.scheme() == "http"
                            && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                            && url.port() == Some(1420))
                });
            window.add_child(main, LogicalPosition::new(0, 0), window.inner_size()?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_browser_info,
            native_browser_open,
            native_browser_layout
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
