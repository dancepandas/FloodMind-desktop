import base64
from pathlib import Path
from floodmind_desktop_sidecar.attachments import (
    normalize_attachments, MAX_IMAGE_BYTES, IMAGE_EXTS,
)


def _png_bytes():
    # 1x1 PNG.
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
    )


def test_workspace_image_resolves_to_abs_path(tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    (ws / "chart.png").write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "workspace", "name": "chart.png", "mime": "image/png"}],
        str(ws), tmp_path / "stage")
    assert errs == []
    assert len(atts) == 1
    assert atts[0].kind == "image"
    assert atts[0].mime_type == "image/png"
    assert atts[0].path.endswith("chart.png")


def test_workspace_path_escape_rejected(tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    (tmp_path / "secret.png").write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "workspace", "name": "../secret.png", "mime": "image/png"}],
        str(ws), tmp_path / "stage")
    assert atts == []
    assert len(errs) == 1


def test_file_source_uses_abs_path(tmp_path):
    img = tmp_path / "drop.png"; img.write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "drop.png", "mime": "image/png"}],
        None, tmp_path / "stage")
    assert errs == [] and len(atts) == 1
    assert atts[0].path == str(img)


def test_clipboard_stages_to_file(tmp_path):
    stage = tmp_path / "stage"
    atts, errs = normalize_attachments(
        [{"source": "clipboard", "data": base64.b64encode(_png_bytes()).decode(),
          "mime": "image/png", "name": "pasted.png"}],
        None, stage)
    assert errs == [] and len(atts) == 1
    assert Path(atts[0].path).exists()
    assert atts[0].size == len(_png_bytes())


def test_oversized_image_rejected(tmp_path):
    img = tmp_path / "big.png"; img.write_bytes(b"\0" * (MAX_IMAGE_BYTES + 1))
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "big.png", "mime": "image/png"}],
        None, tmp_path / "stage")
    assert atts == [] and len(errs) == 1


def test_non_image_ext_rejected(tmp_path):
    img = tmp_path / "note.txt"; img.write_bytes(b"hi")
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "note.txt", "mime": "text/plain"}],
        None, tmp_path / "stage")
    assert atts == [] and len(errs) == 1


def test_multiple_attachments_partial_failure(tmp_path):
    img = tmp_path / "ok.png"; img.write_bytes(_png_bytes())
    atts, errs = normalize_attachments(
        [{"source": "file", "path": str(img), "name": "ok.png", "mime": "image/png"},
         {"source": "file", "path": str(tmp_path / "missing.png"), "name": "missing.png",
          "mime": "image/png"}],
        None, tmp_path / "stage")
    assert len(atts) == 1 and len(errs) == 1
