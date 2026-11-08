from __future__ import annotations

import base64
import asyncio
import binascii
from contextlib import closing
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "glm-ocr:latest")
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "20m")
app = FastAPI(title="NoteBookIDE local API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class RecognizeRequest(BaseModel):
    image: str = Field(min_length=1, max_length=12_000_000)


class CodeRequest(BaseModel):
    code: str = Field(max_length=200_000)
    language: str = "python"


def strip_markdown_code_fence(text: str) -> str:
    """Remove Markdown fences and common repeated-fence OCR artifacts."""
    text = text.strip()
    fenced = re.fullmatch(r"(```|''')[\w.+-]*[ \t]*\r?\n([\s\S]*?)\r?\n\1", text)
    if fenced:
        text = fenced.group(2).strip("\r\n")

    lines = text.splitlines()
    fence_pattern = re.compile(r"\s*(?:```|''')(?:[\w.+-]+)?\s*")
    fence_count = sum(bool(fence_pattern.fullmatch(line)) for line in lines)
    if fence_count <= 3:
        return text

    cleaned: list[str] = []
    for line in lines:
        if fence_pattern.fullmatch(line):
            continue
        if not line.strip() and (not cleaned or not cleaned[-1].strip()):
            continue
        if line.strip() and cleaned:
            previous_text = next((item.strip() for item in reversed(cleaned) if item.strip()), None)
            if previous_text == line.strip():
                while cleaned and not cleaned[-1].strip():
                    cleaned.pop()
                continue
        cleaned.append(line)
    return "\n".join(cleaned).strip("\r\n")


def split_sql_statements(code: str) -> list[tuple[str, int]]:
    """Split a SQL script at complete semicolons while respecting quoted text."""
    statements: list[tuple[str, int]] = []
    buffer = ""
    line = 1
    start_line = 1
    for character in code:
        if not buffer.strip():
            start_line = line
        buffer += character
        if character == ";" and sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement:
                statements.append((statement, start_line))
            buffer = ""
        if character == "\n":
            line += 1
    if buffer.strip():
        statements.append((buffer.strip(), start_line))
    return statements


class SQLScriptError(Exception):
    def __init__(self, line: int, message: str):
        super().__init__(f"line {line}: {message}")
        self.line = line


def execute_sql_script(code: str, timeout: float = 5) -> str:
    """Execute a script against a fresh in-memory SQLite database."""
    output: list[str] = []
    deadline = time.monotonic() + timeout
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
        for index, (statement, line) in enumerate(split_sql_statements(code), start=1):
            try:
                cursor = connection.execute(statement)
                if cursor.description:
                    columns = [item[0] for item in cursor.description]
                    rows = cursor.fetchall()
                    output.append(f"Query {index} ({len(rows)} row{'s' if len(rows) != 1 else ''}):")
                    output.append("\t".join(columns))
                    output.extend("\t".join("NULL" if value is None else str(value).replace("\n", "\\n") for value in row) for row in rows)
                else:
                    affected = cursor.rowcount
                    suffix = f" ({affected} row{'s' if affected != 1 else ''} affected)" if affected >= 0 else ""
                    output.append(f"Statement {index}: executed{suffix}.")
            except sqlite3.Error as error:
                raise SQLScriptError(line, str(error)) from error
    return "\n".join(output) if output else "SQL script completed (no statements)."


@app.get("/api/health")
async def health() -> dict[str, str]:
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            response = await client.get(f"{OLLAMA_URL.rstrip('/')}/api/tags")
            response.raise_for_status()
        models = response.json().get("models", [])
        names = [model.get("name", "") for model in models]
        ready = any(name == OLLAMA_MODEL or name.split(":", 1)[0] == OLLAMA_MODEL.split(":", 1)[0] for name in names)
        return {"status": "ok", "model": OLLAMA_MODEL, "ollama": "ready", "model_ready": str(ready).lower()}
    except (httpx.HTTPError, OSError, ValueError):
        return {"status": "ok", "model": OLLAMA_MODEL, "ollama": "offline", "model_ready": "false"}


@app.post("/api/warm")
async def warm_model() -> dict[str, str]:
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(
                f"{OLLAMA_URL.rstrip('/')}/api/generate",
                json={"model": OLLAMA_MODEL, "prompt": " ", "stream": False, "keep_alive": OLLAMA_KEEP_ALIVE, "options": {"num_predict": 1}},
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=exc.response.text[:500] or "Ollama warm-up failed") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not warm Ollama model: {exc}") from exc
    return {"status": "warm", "model": OLLAMA_MODEL}


@app.post("/api/recognize")
async def recognize(payload: RecognizeRequest, request: Request) -> dict[str, str]:
    encoded = payload.image.split(",", 1)[-1]
    try:
        base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid image data") from exc
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            upstream = asyncio.create_task(client.post(
                f"{OLLAMA_URL.rstrip('/')}/api/generate",
                json={
                    "model": OLLAMA_MODEL,
                    "prompt": "Text Recognition: Transcribe only the handwritten text that is visibly present in this image. Preserve spelling, capitalization, punctuation, line breaks, and indentation. Do not interpret, correct, complete, repeat, explain, or wrap the result in Markdown.",
                    "images": [encoded],
                    "stream": False,
                    "keep_alive": OLLAMA_KEEP_ALIVE,
                    "options": {"temperature": 0, "num_predict": 256},
                },
            ))
            while not upstream.done():
                if await request.is_disconnected():
                    upstream.cancel()
                    raise HTTPException(status_code=499, detail="Recognition cancelled")
                await asyncio.wait({upstream}, timeout=0.2)
            response = await upstream
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500] or "Ollama returned an error"
        raise HTTPException(status_code=502, detail=detail) from exc
    except (httpx.HTTPError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Ollama at {OLLAMA_URL}: {exc}") from exc
    return {"text": strip_markdown_code_fence(response.json().get("response", ""))}


SUPPORTED_LANGUAGES = {"python", "javascript", "typescript", "java", "c", "cpp", "go", "rust"}


def get_command(language: str, folder: Path, *, check_only: bool = False) -> list[str]:
    """Create a fixed command for a supported language; never invoke a shell."""
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")
    if language == "python":
        source = folder / "main.py"
        return [sys.executable, "-I", "-m", "py_compile", str(source)] if check_only else [sys.executable, "-I", str(source)]
    if language in {"javascript", "typescript"}:
        if language == "typescript" and check_only:
            return ["tsc", "--noEmit", "--pretty", "false", "--skipLibCheck", "--target", "ES2020", str(folder / "main.ts")]
        if language == "typescript":
            return ["tsc", "--pretty", "false", "--skipLibCheck", "--target", "ES2020", "--module", "commonjs", "--outDir", str(folder / "out"), str(folder / "main.ts")]
        return ["node", "--check", str(folder / "main.js")] if check_only else ["node", str(folder / "main.js")]
    if language == "java":
        source = folder / "Main.java"
        return ["javac", str(source)] if check_only else ["java", "-cp", str(folder), "Main"]
    if language in {"c", "cpp"}:
        compiler = "gcc" if language == "c" else "g++"
        source = folder / ("main.c" if language == "c" else "main.cpp")
        output = folder / ("main.exe" if os.name == "nt" else "main")
        return [compiler, "-fsyntax-only", str(source)] if check_only else [compiler, str(source), "-o", str(output)]
    if language == "go":
        return ["gofmt", "-d", str(folder / "main.go")] if check_only else ["go", "run", str(folder / "main.go")]
    if language == "rust":
        source = folder / "main.rs"
        return ["rustc", "--edition", "2021", "--emit", "metadata", str(source)] if check_only else ["rustc", "--edition", "2021", str(source), "-o", str(folder / ("main.exe" if os.name == "nt" else "main"))]
    raise HTTPException(status_code=400, detail="Unsupported language")


def source_name(language: str) -> str:
    return {"python":"main.py", "javascript":"main.js", "typescript":"main.ts", "java":"Main.java", "c":"main.c", "cpp":"main.cpp", "go":"main.go", "rust":"main.rs"}[language]


def execute(command: list[str], folder: Path, timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=folder, capture_output=True, text=True, timeout=timeout)


@app.post("/api/lint")
async def lint(payload: CodeRequest) -> dict[str, str | bool]:
    language = payload.language.lower()
    if language == "sqlite":
        try:
            execute_sql_script(payload.code)
            return {"ok": True, "output": "SQLite script check passed."}
        except SQLScriptError as error:
            return {"ok": False, "output": str(error)}
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")
    with tempfile.TemporaryDirectory(prefix="notebookide-check-") as temp_dir:
        folder = Path(temp_dir)
        source = folder / source_name(language)
        source.write_text(payload.code, encoding="utf-8")
        try:
            command = get_command(language, folder, check_only=True)
            result = execute(command, folder)
        except FileNotFoundError:
            return {"ok": False, "output": f"Required compiler/checker for {language} is not installed or not on PATH."}
        except subprocess.TimeoutExpired:
            return {"ok": False, "output": "Check stopped after 10 seconds."}
        if result.returncode:
            return {"ok": False, "output": (result.stdout + result.stderr).strip() or "Check failed."}
        if language == "python" and shutil.which("ruff"):
            ruff = subprocess.run(["ruff", "check", "--output-format", "concise", str(source)], capture_output=True, text=True, timeout=10)
            return {"ok": ruff.returncode == 0, "output": ruff.stdout.strip() or ruff.stderr.strip() or "No syntax errors. Ruff found no issues."}
        return {"ok": True, "output": f"{language.title()} check passed."}


@app.post("/api/run")
async def run_code(payload: CodeRequest) -> dict[str, str | int]:
    # This endpoint is intended for trusted local code; it is not an OS-level sandbox.
    language = payload.language.lower()
    if language == "sqlite":
        try:
            return {"output": execute_sql_script(payload.code), "exit_code": 0}
        except SQLScriptError as error:
            return {"output": str(error), "exit_code": 1}
    with tempfile.TemporaryDirectory(prefix="notebookide-") as temp_dir:
        if language not in SUPPORTED_LANGUAGES:
            raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")
        folder = Path(temp_dir)
        script = folder / source_name(language)
        script.write_text(payload.code, encoding="utf-8")
        try:
            command = get_command(language, folder)
            if language in {"c", "cpp", "rust", "typescript"}:
                build = execute(command, folder)
                if build.returncode:
                    return {"output": (build.stdout + build.stderr).strip(), "exit_code": build.returncode}
                if language == "typescript":
                    command = ["node", str(folder / "out" / "main.js")]
                else:
                    executable = folder / ("main.exe" if os.name == "nt" else "main")
                    command = [str(executable)]
            elif language == "java":
                build = execute(get_command(language, folder, check_only=True), folder)
                if build.returncode:
                    return {"output": (build.stdout + build.stderr).strip(), "exit_code": build.returncode}
            result = execute(command, folder, timeout=5)
        except FileNotFoundError:
            return {"output": f"Required runtime/compiler for {language} is not installed or not on PATH.", "exit_code": 127}
        except subprocess.TimeoutExpired as exc:
            partial = exc.stdout or ""
            if isinstance(partial, bytes):
                partial = partial.decode("utf-8", errors="replace")
            return {"output": partial + "\nStopped after 5 seconds.", "exit_code": 124}
        return {
            "output": (result.stdout + result.stderr).strip() or "(no output)",
            "exit_code": result.returncode,
        }
