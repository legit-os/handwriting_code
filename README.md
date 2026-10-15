# NoteBookIDE

NoteBookIDE is a local-first code editor that turns handwritten code into editable source code. It combines a Monaco editor with a handwriting pad and uses GLM-OCR through a local Ollama service to recognize what you write. Review and edit the recognized text before inserting it into your code.

The application runs on your computer. Handwriting images are sent to the Ollama service configured for the local API; NoteBookIDE does not require a hosted OCR account.

## What you can do

- Write, open, and save source files in a Monaco-powered editor.
- Open a project folder and work with multiple files in tabs. The browser stores recent session state for restore.
- Draw code with a mouse, touch screen, or pen. Move and resize the handwriting pad, undo or redo strokes, and adjust pen width.
- Recognize handwriting with GLM-OCR, compare the drawing with editable OCR output, then insert the reviewed code at the saved editor selection.
- Check and run supported single-file programs using local language toolchains.
- See supported checker diagnostics alongside editor line numbers.
- Use keyboard shortcuts: **Ctrl+S** save, **Ctrl+I** open handwriting, **Ctrl+K** check, and **Ctrl+Enter** run.

### Language support

| Language | Editor highlighting | Check / run requirements |
| --- | --- | --- |
| Python | Python | Python 3 |
| JavaScript | JavaScript | Node.js |
| TypeScript | TypeScript | Node.js and TypeScript tooling |
| Java | Java | JDK (`javac` and `java`) |
| C | C | A C compiler such as GCC or Clang |
| C++ | C++ | A C++ compiler such as G++ or Clang++ |
| Go | Go | Go toolchain |
| Rust | Rust | Rust toolchain (`rustc`) |

Language highlighting is provided by Monaco. Checking and execution are performed by local tools and are available only when the corresponding toolchain is installed and on `PATH`.

## Requirements

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/) for the API environment
- Node.js 20 or newer and npm
- [Ollama](https://ollama.com/download) running locally, either installed on the host or in Docker
- The `glm-ocr:latest` model (downloaded once through Ollama)
- Optional language runtimes/compilers for checking and running code

## 1. Start Ollama

Choose either a native Ollama installation or the Docker setup below. Both expose Ollama on `http://127.0.0.1:11434`, which is the NoteBookIDE default.

### Native Ollama

Install Ollama using the [official download page](https://ollama.com/download), start it, then pull the model:

```sh
ollama pull glm-ocr:latest
ollama list
```

### Ollama with Docker

Docker keeps the model in a named volume so it remains available after the container restarts:

```sh
docker run -d --name ollama \
  -v ollama:/root/.ollama \
  -p 11434:11434 \
  ollama/ollama

docker exec -it ollama ollama pull glm-ocr:latest
docker exec -it ollama ollama list
```

For GPU-specific Docker options, see the [official Ollama Docker guide](https://docs.ollama.com/docker). If you already have a container named `ollama`, start it with `docker start ollama` rather than creating another one.

## 2. Start the NoteBookIDE API

Run these commands from the repository root. `uv` creates a virtual environment and installs the API dependencies listed in `backend/requirements.txt`.

### Windows PowerShell

```powershell
uv venv
uv pip install --python .venv\Scripts\python.exe -r backend\requirements.txt
uv run --python .venv\Scripts\python.exe uvicorn backend.app:app --host 127.0.0.1 --port 8765 --reload
```

### macOS / Linux

```sh
uv venv
uv pip install --python .venv/bin/python -r backend/requirements.txt
uv run --python .venv/bin/python uvicorn backend.app:app --host 127.0.0.1 --port 8765 --reload
```

Keep this terminal open while using the app. The API defaults to Ollama at `http://127.0.0.1:11434` and model `glm-ocr:latest`. To use a different Ollama URL or model, set `OLLAMA_URL` and/or `OLLAMA_MODEL` before starting the API. For example, in PowerShell:

```powershell
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "glm-ocr:latest"
```

## 3. Start the frontend

In a second terminal:

```sh
cd frontend
npm ci
npm run dev
```

Open the local address printed by Vite, usually [http://localhost:5173](http://localhost:5173). The API runs at `http://127.0.0.1:8765`.

## First use

1. Create a file or open a file/folder from the editor toolbar.
2. Choose the file's language if it was not detected from its extension.
3. Place the editor caret where the recognized code should go and open the handwriting pad with **Ctrl+I**.
4. Draw your code, then request recognition. Review and edit the OCR result before inserting it.
5. Save with **Ctrl+S**. Use **Ctrl+K** to check or **Ctrl+Enter** to run the current file when its language tools are installed.

The browser's File System Access API enables direct file and folder access in supported browsers. Other browsers may use file upload and download instead. Session restore data is stored locally by the browser.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server base URL |
| `OLLAMA_MODEL` | `glm-ocr:latest` | Model used for OCR and readiness checks |

The API health endpoint is `http://127.0.0.1:8765/api/health`.

## Run tests

From the repository root, install the backend test dependencies as described above, then run:

```powershell
.venv\Scripts\python.exe -m unittest discover -s backend\tests -t . -v
cd frontend
npm ci
npm test
```

`tests/language_smoke/` contains small sample programs for the supported languages. Running those examples requires each corresponding runtime or compiler to be installed.

## Current scope and safety

Program checks and runs use a temporary directory and a five-second timeout. Execution is for trusted local code only; it is not a security sandbox. The current output panel captures command output. Interactive terminal sessions and project-aware multi-file build/run workflows are not implemented yet.

## Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. When reporting a problem, include your operating system, browser, Python and Node versions, Ollama version, and the relevant API or browser-console error. Please do not include private source files or sensitive OCR images in public reports.
