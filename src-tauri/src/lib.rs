mod clipboard;
mod sidecar;

use sidecar::SidecarHandle;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = sidecar::spawn_sidecar().expect("failed to start Python sidecar");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(handle) = window.app_handle().try_state::<SidecarHandle>() {
                    handle.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            sidecar::get_sidecar_base_url,
            open_path,
            clipboard::get_clipboard_file_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    // Open the file/folder with the OS default application. We deliberately
    // avoid `cmd /c start` (and any shell) so a workspace filename containing
    // shell metacharacters (`&`, `|`, …) cannot be executed as a command.
    // `open::that` calls ShellExecuteW on Windows, `open` on macOS and
    // xdg-open on Linux — passing the path as a literal argv element.
    //
    // URLs (https/mailto) aren't absolute filesystem paths; skip the check so
    // `open::that` can route them to the system browser / mail client.
    let lower = path.to_lowercase();
    let is_url = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    if !is_url {
        let p = std::path::Path::new(&path);
        if !p.is_absolute() {
            return Err("path must be absolute".into());
        }
    }
    open::that(&path).map_err(|e| e.to_string())
}
