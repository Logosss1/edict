"""Attachment isolation, bounded parsers, and safe staging."""
import base64
import io
import json
import pathlib
import stat
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "vendor" / "python"))
import chat_attachments as attachments
from chat_attachments import AttachmentStore


SCOPE = "ysf-012345abcdef"
OTHER = "court-0123abcd"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQp0AAAAASUVORK5CYII="
)


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as handle:
        for name, data in entries.items():
            handle.writestr(name, data)
    return output.getvalue()


def docx(text="Hello document"):
    return archive({"word/document.xml": f'<document><body><p><r><t>{text}</t></r></p></body></document>'})


def test_roundtrip_public_metadata_permissions_and_isolation(tmp_path):
    store = AttachmentStore(tmp_path / "data")
    item = store.upload(SCOPE, "notes.md", b"Important notes")
    assert set(item) == {"id", "name", "size", "mime", "kind"}
    assert item["kind"] == "text"
    assert store.read(SCOPE, item["id"]) == (item, b"Important notes")
    assert store.resolve(SCOPE, [item["id"]]) == [item]
    assert "Important notes" in store.context(SCOPE, [item])
    assert "UNTRUSTED" in store.context(SCOPE, [item])
    with pytest.raises(ValueError):
        store.read(OTHER, item["id"])
    with pytest.raises(ValueError):
        store.resolve(OTHER, [item["id"]])
    for path in store.root_dir.rglob("*"):
        assert stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)


@pytest.mark.parametrize("scope", ["../outside", "ysf-abc", "court-012345678", "ysf-012345ABCDEF", ""])
def test_invalid_scopes(tmp_path, scope):
    with pytest.raises(ValueError):
        AttachmentStore(tmp_path).upload(scope, "notes.txt", b"notes")


@pytest.mark.parametrize("name", ["../file.txt", "/file.txt", "a\\file.txt", "file.exe", "a\n.txt", "a\x00.txt"])
def test_invalid_names(tmp_path, name):
    with pytest.raises(ValueError):
        AttachmentStore(tmp_path).upload(SCOPE, name, b"notes")


@pytest.mark.parametrize("name,data", [
    ("notes.txt", b"\x00binary"), ("notes.txt", b"\xffbad"),
    ("image.png", b"not an image"), ("image.jpg", PNG),
    ("file.docx", b"not a zip"), ("file.pdf", b"not a PDF"),
])
def test_invalid_content(tmp_path, name, data):
    with pytest.raises(ValueError):
        AttachmentStore(tmp_path).upload(SCOPE, name, data)


def test_size_and_message_limits(tmp_path, monkeypatch):
    store = AttachmentStore(tmp_path)
    monkeypatch.setattr(attachments, "MAX_FILE_BYTES", 10)
    monkeypatch.setattr(attachments, "MAX_SCOPE_BYTES", 15)
    first = store.upload(SCOPE, "one.txt", b"0123456789")
    with pytest.raises(ValueError, match="单个附件"):
        store.upload(SCOPE, "large.txt", b"x" * 11)
    with pytest.raises(ValueError, match="附件总量"):
        store.upload(SCOPE, "two.txt", b"123456")
    with pytest.raises(ValueError, match="最多"):
        store.resolve(SCOPE, [first["id"]] * 9)
    with pytest.raises(ValueError, match="重复"):
        store.resolve(SCOPE, [first["id"]] * 2)


def test_text_context_bounds_and_empty_warning(tmp_path):
    store = AttachmentStore(tmp_path)
    items = [store.upload(SCOPE, f"{index}.txt", b"x" * 40_000) for index in range(3)]
    assert all("截断" in item["warning"] for item in items)
    context = store.context(SCOPE, items)
    assert len(context) <= attachments.MAX_CONTEXT_CHARS
    assert "[Attachment text truncated]" in context
    assert context.endswith("[END UNTRUSTED ATTACHMENT REFERENCES]")
    with pytest.raises(ValueError, match="空文件"):
        store.upload(SCOPE, "empty.txt", b"")
    item = store.upload(SCOPE, "blank.txt", b" \n ")
    assert "未提取到可读文字" in item["warning"]
    utf16 = store.upload(SCOPE, "unicode.txt", "Unicode text".encode("utf-16"))
    assert "Unicode text" in store.context(SCOPE, [utf16])


def test_docx_xlsx_and_images(tmp_path):
    store = AttachmentStore(tmp_path)
    document = store.upload(SCOPE, "document.docx", docx())
    assert "Hello document" in store.context(SCOPE, [document])
    sheet_data = archive({
        "xl/sharedStrings.xml": "<sst><si><t>Shared value</t></si></sst>",
        "xl/worksheets/sheet1.xml": (
            '<worksheet><sheetData><row><c t="s"><v>0</v></c>'
            '<c t="inlineStr"><is><t>Inline value</t></is></c>'
            '<c><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'
        ),
    })
    sheet = store.upload(SCOPE, "data.xlsx", sheet_data)
    context = store.context(SCOPE, [sheet])
    assert "Shared value\tInline value\t2" in context
    assert "不执行公式" in sheet["warning"]
    image = store.upload(SCOPE, "picture.png", PNG)
    assert image["kind"] == "image" and image["mime"] == "image/png"
    assert "read tool" in store.context(SCOPE, [image])
    assert "未进行 OCR" in image["warning"]


@pytest.mark.parametrize("bad_name", ["../escape", "/escape", "word/../../escape", "word\\escape", "C:/escape"])
def test_archive_traversal_members_rejected(tmp_path, bad_name):
    data = archive({"word/document.xml": "<document/>", bad_name: "bad"})
    with pytest.raises(ValueError):
        AttachmentStore(tmp_path).upload(SCOPE, "bad.docx", data)
    assert not (tmp_path.parent / "escape").exists()


def test_archive_entity_and_expansion_limits(tmp_path, monkeypatch):
    store = AttachmentStore(tmp_path)
    xml = '<!DOCTYPE x [<!ENTITY x "bad">]><document><p><t>&x;</t></p></document>'
    with pytest.raises(ValueError):
        store.upload(SCOPE, "entity.docx", archive({"word/document.xml": xml}))
    with pytest.raises(ValueError):
        store.upload(SCOPE, "entity16.docx", archive({"word/document.xml": xml.encode("utf-16")}))
    monkeypatch.setattr(attachments, "MAX_ARCHIVE_BYTES", 20)
    with pytest.raises(ValueError):
        store.upload(SCOPE, "large.docx", docx())
    monkeypatch.setattr(attachments, "MAX_ARCHIVE_BYTES", 10_000)
    monkeypatch.setattr(attachments, "MAX_ARCHIVE_MEMBERS", 1)
    with pytest.raises(ValueError):
        store.upload(SCOPE, "many.docx", archive({"word/document.xml": "<document/>", "extra": "x"}))


def test_stage_verified_original_and_document_text(tmp_path):
    store = AttachmentStore(tmp_path / "data")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    document = store.upload(SCOPE, "document.docx", docx())
    image = store.upload(SCOPE, "image.png", PNG)
    paths = store.stage(SCOPE, [document, image], workspace)
    assert len(paths) == 3
    assert all(not pathlib.Path(path).is_absolute() and path.startswith("attachments/") for path in paths)
    assert (workspace / paths[0]).read_bytes() == docx()
    assert (workspace / paths[1]).read_text() == "Hello document"
    assert (workspace / paths[2]).read_bytes() == PNG
    assert paths[0] in store.context(SCOPE, [document])
    assert store.stage(SCOPE, [document, image], workspace) == paths
    for path in paths:
        assert stat.S_IMODE((workspace / path).stat().st_mode) == 0o600
    source = store.root_dir / SCOPE / document["id"] / "source.docx"
    source.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="完整性"):
        store.stage(SCOPE, [document], workspace)


def test_storage_and_workspace_symlinks_are_rejected(tmp_path):
    store = AttachmentStore(tmp_path / "data")
    item = store.upload(SCOPE, "note.txt", b"original")
    outside = tmp_path / "outside"
    outside.mkdir()
    (store.root_dir / OTHER).symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        store.upload(OTHER, "escape.txt", b"escape")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "attachments").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        store.stage(SCOPE, [item], workspace)
    source = store.root_dir / SCOPE / item["id"] / "source.txt"
    source.unlink()
    secret = outside / "secret.txt"
    secret.write_text("secret")
    source.symlink_to(secret)
    with pytest.raises(ValueError):
        store.read(SCOPE, item["id"])
    assert list(outside.iterdir()) == [secret]


def test_ids_and_supplied_metadata_cannot_select_other_paths(tmp_path):
    store = AttachmentStore(tmp_path)
    item = store.upload(SCOPE, "note.txt", b"original")
    with pytest.raises(ValueError):
        store.read(SCOPE, "../metadata.json")
    spoofed = dict(item, name="../../escape", filename="../../escape", text="spoofed")
    context = store.context(SCOPE, [spoofed])
    assert "original" in context and "spoofed" not in context and "../../escape" not in context
    metadata_path = store.root_dir / SCOPE / item["id"] / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["filename"] = "../../escape"
    metadata_path.write_text(json.dumps(metadata))
    with pytest.raises(ValueError):
        store.read(SCOPE, item["id"])


def test_delete_draft_and_stage_creates_workspace(tmp_path):
    store = AttachmentStore(tmp_path / "data")
    item = store.upload(SCOPE, "draft.txt", b"draft")
    workspace = tmp_path / "runtime" / "workspace"
    assert store.stage(SCOPE, [item], workspace)
    with pytest.raises(ValueError):
        store.delete(OTHER, item["id"])
    assert store.read(SCOPE, item["id"])[1] == b"draft"
    store.delete(SCOPE, item["id"])
    assert not (store.root_dir / SCOPE / item["id"]).exists()
    with pytest.raises(ValueError):
        store.read(SCOPE, item["id"])


def test_scope_quota_serializes_multiple_store_instances(tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_SCOPE_BYTES", 10)

    def upload(index):
        try:
            return AttachmentStore(tmp_path).upload(SCOPE, f"{index}.txt", b"123456")
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(upload, range(2)))
    assert sum(result is not None for result in results) == 1


def test_empty_spreadsheet_has_no_text_warning(tmp_path):
    item = AttachmentStore(tmp_path).upload(
        SCOPE, "empty.xlsx",
        archive({"xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>"}),
    )
    assert "未提取到可读文字" in item["warning"]


def test_pdf_blank_page_and_invalid_bytes(tmp_path):
    import pypdf
    output = io.BytesIO()
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(output)
    store = AttachmentStore(tmp_path)
    item = store.upload(SCOPE, "blank.pdf", output.getvalue())
    assert "未提取到可读文字" in item["warning"]
    assert "未进行 OCR" in item["warning"]
    with pytest.raises(ValueError):
        store.upload(SCOPE, "broken.pdf", b"%PDF-1.4\nbroken")


def text_pdf(content=b"BT /F1 12 Tf 10 10 Td (Hello PDF) Tj ET", *, compressed=False):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({
            NameObject("/F1"): DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }),
        }),
    })
    stream = DecodedStreamObject()
    stream.set_data(content)
    page.replace_contents(stream.flate_encode() if compressed else stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def test_pdf_text_and_automatic_bundled_dependency_loading(tmp_path):
    data = text_pdf()
    store = AttachmentStore(tmp_path)
    item = store.upload(SCOPE, "text.pdf", data)
    assert "Hello PDF" in store.context(SCOPE, [item])
    script = (
        "import sys, tempfile, base64\n"
        f"sys.path.insert(0, {str(ROOT / 'dashboard')!r})\n"
        "from chat_attachments import AttachmentStore\n"
        "with tempfile.TemporaryDirectory() as directory:\n"
        "    store = AttachmentStore(directory)\n"
        f"    item = store.upload({SCOPE!r}, 'text.pdf', base64.b64decode({base64.b64encode(data)!r}))\n"
        f"    assert 'Hello PDF' in store.context({SCOPE!r}, [item])\n"
    )
    result = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


def test_pdf_native_decompression_and_total_content_limits(tmp_path, monkeypatch):
    from pypdf import filters

    compressed = text_pdf(b" " * 1000, compressed=True)
    monkeypatch.setattr(filters, "ZLIB_MAX_OUTPUT_LENGTH", 100)
    with pytest.raises(ValueError):
        AttachmentStore(tmp_path).upload(SCOPE, "compressed.pdf", compressed)
    monkeypatch.setattr(attachments, "MAX_PDF_CONTENT_BYTES", 10)
    with pytest.raises(ValueError):
        AttachmentStore(tmp_path).upload(SCOPE, "content.pdf", text_pdf())


def test_pdf_page_limit_and_encryption(tmp_path):
    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(101):
        writer.add_blank_page(width=100, height=100)
    output = io.BytesIO()
    writer.write(output)
    store = AttachmentStore(tmp_path)
    item = store.upload(SCOPE, "pages.pdf", output.getvalue())
    assert "前 100 页" in item["warning"]
    writer.encrypt("secret")
    encrypted = io.BytesIO()
    writer.write(encrypted)
    with pytest.raises(ValueError):
        store.upload(SCOPE, "encrypted.pdf", encrypted.getvalue())
