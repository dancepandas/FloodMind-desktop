use std::path::PathBuf;

/// Map an arboard file-list read to a deduped `Vec<String>`. Any failure
/// (clipboard busy, no file payload, unsupported platform) yields an empty
/// vec — file paste is best-effort and must never break a normal text paste.
/// Generic over `E` so tests can exercise it deterministically with `()`.
fn read_clipboard_paths<E>(read: impl FnOnce() -> Result<Vec<PathBuf>, E>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    match read() {
        Ok(paths) => paths
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .filter(|s| seen.insert(s.clone()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Return the file paths on the clipboard (Explorer "Copy" puts CF_HDROP there),
/// as strings. Empty when the clipboard holds no file list or is unreadable.
#[tauri::command]
pub fn get_clipboard_file_paths() -> Vec<String> {
    let mut cb = match arboard::Clipboard::new() {
        Ok(cb) => cb,
        Err(_) => return Vec::new(),
    };
    read_clipboard_paths(|| cb.get().file_list())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ok_paths_and_dedupes() {
        let out = read_clipboard_paths::<()>(|| {
            Ok(vec![
                PathBuf::from(r"C:\a\b.txt"),
                PathBuf::from(r"C:\a\b.txt"),
            ])
        });
        assert_eq!(out, vec![r"C:\a\b.txt".to_string()]);
    }

    #[test]
    fn empty_on_error() {
        // Constructing arboard::Error is blocked by #[non_exhaustive], so the
        // generic E=() lets us test the error branch deterministically.
        let out = read_clipboard_paths::<()>(|| Err(()));
        assert!(out.is_empty());
    }
}
