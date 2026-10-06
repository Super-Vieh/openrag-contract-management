"""Unit tests for ``LangflowFileService.download_user_file_by_name``.

The method is the missing half of an Update/re-ingest: the ingestion path
already replaces an existing document, but the bytes it needs only exist in
the Langflow file store. These tests pin the three properties that would
otherwise fail silently:

* ``GET /api/v2/files/{id}`` must be called WITHOUT ``return_content`` - that
  parameter returns the payload decoded to text and would corrupt binary
  documents without raising.
* The name is resolved against ``path``, not ``name`` (the listing's ``name``
  has the extension stripped), and against the ``.txt``/``.md`` aliases the
  ingestion path itself creates.
* The returned tuple carries the REQUESTED filename, because that is the name
  the document is indexed under in OpenSearch.
"""

import pytest

from services.langflow_file_service import LangflowFileService


class _Response:
    def __init__(self, status_code=200, json_data=None, content=b""):
        self.status_code = status_code
        self._json_data = json_data
        self.content = content

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _patch_langflow(monkeypatch, listing, content_by_id):
    """Point the service at a fake v2 file store; return it plus the calls made."""
    calls = []

    async def langflow_request(method, endpoint, **kwargs):
        calls.append((method, endpoint, kwargs))
        if method == "GET" and endpoint == "/api/v2/files":
            return _Response(json_data=listing)
        file_id = endpoint.rsplit("/", 1)[-1]
        if file_id in content_by_id:
            return _Response(content=content_by_id[file_id])
        return _Response(status_code=404)

    monkeypatch.setattr("services.langflow_file_service.clients.langflow_request", langflow_request)
    return LangflowFileService(), calls


@pytest.mark.asyncio
async def test_returns_bytes_and_guessed_mimetype(monkeypatch):
    listing = [{"id": "f1", "name": "Dienstleistungen", "path": "uid/Dienstleistungen.md"}]
    service, calls = _patch_langflow(monkeypatch, listing, {"f1": b"# Titel\n"})

    result = await service.download_user_file_by_name("Dienstleistungen.md")

    assert result == ("Dienstleistungen.md", b"# Titel\n", "text/markdown")
    # No return_content: that variant decodes to text and would corrupt binaries.
    assert calls[1] == ("GET", "/api/v2/files/f1", {})


@pytest.mark.asyncio
async def test_preserves_binary_content_byte_for_byte(monkeypatch):
    payload = b"%PDF-1.7\x00\xff\xfe\x00 binary"
    listing = [{"id": "f2", "name": "vertrag", "path": "uid/vertrag.pdf"}]
    service, _ = _patch_langflow(monkeypatch, listing, {"f2": payload})

    _, content, content_type = await service.download_user_file_by_name("vertrag.pdf")

    assert content == payload
    assert content_type == "application/pdf"


@pytest.mark.asyncio
async def test_matches_txt_upload_stored_as_md(monkeypatch):
    # langflow_safe_filename_and_mimetype renames .txt -> .md before the store
    # write, so looking up the original name alone would never match.
    listing = [{"id": "f3", "name": "notizen", "path": "uid/notizen.md"}]
    service, _ = _patch_langflow(monkeypatch, listing, {"f3": b"text"})

    result = await service.download_user_file_by_name("notizen.txt")

    assert result is not None
    assert result[0] == "notizen.txt"


@pytest.mark.asyncio
async def test_unknown_name_returns_none(monkeypatch):
    service, _ = _patch_langflow(monkeypatch, [], {})

    assert await service.download_user_file_by_name("weg.pdf") is None


@pytest.mark.asyncio
async def test_empty_stored_file_returns_none(monkeypatch):
    listing = [{"id": "f4", "name": "leer", "path": "uid/leer.md"}]
    service, _ = _patch_langflow(monkeypatch, listing, {"f4": b""})

    assert await service.download_user_file_by_name("leer.md") is None
