import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import base64

from backend.app import (
    SUPPORTED_LANGUAGES,
    CodeRequest,
    RecognizeRequest,
    health,
    get_command,
    lint,
    recognize,
    run_code,
    source_name,
    strip_markdown_code_fence,
    warm_model,
)
from fastapi import HTTPException


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class FakeOllamaClient:
    next_payload = {"response": "ok", "models": []}
    last_request = None

    def __init__(self, *args, **kwargs):
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url):
        return FakeResponse(self.next_payload)

    async def post(self, url, json):
        type(self).last_request = {"url": url, "json": json}
        return FakeResponse(self.next_payload)


class FakeRequest:
    disconnected = False

    async def is_disconnected(self):
        return self.disconnected


class MarkdownFenceTests(unittest.TestCase):
    def test_removes_backtick_python_fence_and_keeps_indentation(self):
        text = "```python\ndef run():\n    return 1\n```"
        self.assertEqual(strip_markdown_code_fence(text), "def run():\n    return 1")

    def test_removes_triple_single_quote_fence(self):
        self.assertEqual(strip_markdown_code_fence("'''javascript\nconsole.log('ok')\n'''"), "console.log('ok')")

    def test_leaves_plain_code_and_surrounding_explanations_unchanged(self):
        code = "print('hello')"
        self.assertEqual(strip_markdown_code_fence(code), code)
        wrapped = "Here is the code:\n```python\nprint('hello')\n```"
        self.assertEqual(strip_markdown_code_fence(wrapped), wrapped)


class OllamaServiceTests(unittest.TestCase):
    def test_health_reports_installed_model(self):
        FakeOllamaClient.next_payload = {"models": [{"name": "glm-ocr:latest"}]}
        with patch("backend.app.httpx.AsyncClient", FakeOllamaClient):
            result = asyncio.run(health())
        self.assertEqual(result["ollama"], "ready")
        self.assertEqual(result["model_ready"], "true")

    def test_warm_request_keeps_model_resident(self):
        FakeOllamaClient.next_payload = {"response": ""}
        with patch("backend.app.httpx.AsyncClient", FakeOllamaClient):
            result = asyncio.run(warm_model())
        self.assertEqual(result["status"], "warm")
        self.assertEqual(FakeOllamaClient.last_request["json"]["keep_alive"], "10m")

    def test_recognition_strips_markdown_before_returning_text(self):
        FakeOllamaClient.next_payload = {"response": "```python\ndef answer():\n    return 42\n```"}
        request = FakeRequest()
        image = "data:image/png;base64," + base64.b64encode(b"image").decode("ascii")
        with patch("backend.app.httpx.AsyncClient", FakeOllamaClient):
            result = asyncio.run(recognize(RecognizeRequest(image=image), request))
        self.assertEqual(result["text"], "def answer():\n    return 42")
        self.assertEqual(FakeOllamaClient.last_request["json"]["keep_alive"], "10m")

    def test_recognition_returns_cancelled_when_client_disconnects(self):
        FakeOllamaClient.next_payload = {"response": "ignored"}
        request = FakeRequest()
        request.disconnected = True
        image = "data:image/png;base64," + base64.b64encode(b"image").decode("ascii")
        with patch("backend.app.httpx.AsyncClient", FakeOllamaClient):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(recognize(RecognizeRequest(image=image), request))
        self.assertEqual(error.exception.status_code, 499)


class LanguageAdapterTests(unittest.TestCase):
    def test_each_supported_language_has_a_source_file_and_command(self):
        expected_names = {
            "python": "main.py", "javascript": "main.js", "typescript": "main.ts",
            "java": "Main.java", "c": "main.c", "cpp": "main.cpp", "go": "main.go", "rust": "main.rs",
        }
        self.assertEqual(SUPPORTED_LANGUAGES, set(expected_names))
        with tempfile.TemporaryDirectory() as folder_name:
            folder = Path(folder_name)
            for language, expected in expected_names.items():
                with self.subTest(language=language):
                    self.assertEqual(source_name(language), expected)
                    self.assertIsInstance(get_command(language, folder), list)
                    self.assertIsInstance(get_command(language, folder, check_only=True), list)

    def test_lint_endpoint_dispatches_for_each_language(self):
        success = subprocess.CompletedProcess([], 0, "", "")
        with patch("backend.app.execute", return_value=success), patch("backend.app.shutil.which", return_value=None):
            for language in sorted(SUPPORTED_LANGUAGES):
                with self.subTest(language=language):
                    result = asyncio.run(lint(CodeRequest(code="sample", language=language)))
                    self.assertTrue(result["ok"])

    def test_lint_endpoint_returns_compiler_diagnostics(self):
        failure = subprocess.CompletedProcess([], 1, "", "main.rs:2:3: expected expression")
        with patch("backend.app.execute", return_value=failure):
            result = asyncio.run(lint(CodeRequest(code="bad", language="rust")))
        self.assertFalse(result["ok"])
        self.assertIn("expected expression", result["output"])

    def test_run_endpoint_dispatches_build_and_run_commands(self):
        success = subprocess.CompletedProcess([], 0, "smoke test passed\n", "")
        for language in sorted(SUPPORTED_LANGUAGES):
            with self.subTest(language=language):
                with patch("backend.app.execute", return_value=success) as execute_mock:
                    result = asyncio.run(run_code(CodeRequest(code="sample", language=language)))
                self.assertEqual(result["exit_code"], 0)
                self.assertIn("smoke test passed", result["output"])
                self.assertEqual(execute_mock.call_count, 2 if language in {"java", "c", "cpp", "rust", "typescript"} else 1)

    def test_missing_runtime_is_reported(self):
        with patch("backend.app.execute", side_effect=FileNotFoundError):
            result = asyncio.run(run_code(CodeRequest(code="print('ok')", language="python")))
        self.assertEqual(result["exit_code"], 127)
        self.assertIn("not installed", result["output"])


if __name__ == "__main__":
    unittest.main()
