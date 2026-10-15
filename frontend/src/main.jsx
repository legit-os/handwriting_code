import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import { Brush, Check, ChevronDown, Code2, FilePlus2, FolderOpen, FolderPlus, Keyboard, Play, Redo2, Save, Sparkles, Terminal, Trash2, Undo2, X } from 'lucide-react';
import { extensionOf, getEditorLanguage, getServiceLanguage, languageBadgeByExtension } from './languages.js';
import './style.css';

const API = 'http://127.0.0.1:8765/api';
const SESSION_KEY = 'notebookide.session.v1';
const starter = `def calculate_total(items):\n    total = sum(items)\n    return total\n\n\nprint(calculate_total([12, 8, 5]))\n`;
const supportedFiles = /\.(py|js|jsx|ts|tsx|java|c|h|cpp|cc|cxx|c\+\+|hpp|hxx|go|rs|txt|json|html|css|md)$/i;
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

function restoreSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (stored?.files?.length) return { files: stored.files.map(file => ({ ...file, handle: null, dirty: Boolean(file.dirty) })), activeId: stored.activeId, projectName: stored.projectName || 'Local project' };
  } catch { /* Start with a fresh editor if stored state cannot be read. */ }
  const file = { id: newId(), name: 'main.py', content: starter, dirty: false, handle: null };
  return { files: [file], activeId: file.id, projectName: 'Local project' };
}

function lineDiagnostics(output, language, model) {
  const diagnostics = [];
  const expressions = [
    /\bline\s+(\d+)(?:,\s*(?:column\s+)?(\d+))?/i,
    /(?:main|Main)\.[\w]+:(\d+)(?::(\d+))?/,
    /[^\s]+\.(?:py|js|ts|tsx|java|c|h|cpp|go|rs):(\d+):(\d+):/,
    /\bmain\.[\w]+\((\d+),(\d+)\)/,
    /-->\s+.*?:(\d+):(\d+)/,
  ];
  for (const row of output.split(/\r?\n/)) {
    const match = expressions.map(expression => row.match(expression)).find(Boolean);
    if (!match) continue;
    const lineNumber = Math.max(1, Math.min(Number(match[1]) || 1, model.getLineCount()));
    const column = Math.max(1, Number(match[2]) || 1);
    diagnostics.push({
      severity: monacoRef.current?.MarkerSeverity?.Error,
      message: row.trim(),
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn: column,
      endColumn: column + 1,
      source: language,
    });
  }
  if (!diagnostics.length && output.trim() && !/check passed|no syntax errors|no issues/i.test(output)) {
    diagnostics.push({ severity: monacoRef.current?.MarkerSeverity?.Error, message: output.trim().slice(0, 300), startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 2, source: language });
  }
  return diagnostics;
}

let monacoRef = { current: null };

function App() {
  const initial = useMemo(restoreSession, []);
  const [files, setFiles] = useState(initial.files);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [projectName, setProjectName] = useState(initial.projectName);
  const [padOpen, setPadOpen] = useState(false);
  const [recognized, setRecognized] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState('Ready');
  const [output, setOutput] = useState('Run your file to see output here.');
  const [panel, setPanel] = useState('terminal');
  const [padSize, setPadSize] = useState({ width: 590, height: 340 });
  const [padPosition, setPadPosition] = useState({ left: 0, top: 0 });
  const [penSize, setPenSize] = useState(3);
  const [serviceState, setServiceState] = useState({ api: 'checking', ollama: 'checking', model: 'checking' });
  const [autosavedAt, setAutosavedAt] = useState(null);
  const editorRef = useRef(null);
  const strokesRef = useRef([]);
  const redoRef = useRef([]);
  const activeStrokeRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const anchorRef = useRef(null);
  const abortRef = useRef(null);
  const warmRef = useRef(false);
  const filesInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const activeFile = files.find(file => file.id === activeId) || files[0];
  const code = activeFile?.content || '';
  const extension = extensionOf(activeFile?.name || 'main.py');
  const language = getServiceLanguage(activeFile?.name || 'main.py');
  const dirty = Boolean(activeFile?.dirty);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ files: files.map(({ id, name, content, dirty }) => ({ id, name, content, dirty })), activeId, projectName }));
        setAutosavedAt(new Date());
      } catch { setMessage('Autosave unavailable: browser storage is full.'); }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [files, activeId, projectName]);

  const setCurrentContent = useCallback((value) => {
    setFiles(current => current.map(file => file.id === activeId ? { ...file, content: value, dirty: true } : file));
  }, [activeId]);

  const addFiles = useCallback((incoming, rootName) => {
    if (!incoming.length) return;
    setFiles(current => {
      const next = [...current];
      let firstId = null;
      for (const item of incoming) {
        const name = item.name;
        const existing = next.find(file => file.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          firstId ||= existing.id;
          continue;
        }
        const file = { id: newId(), name, content: item.content, dirty: false, handle: item.handle || null };
        firstId ||= file.id;
        next.push(file);
      }
      if (firstId) setActiveId(firstId);
      return next;
    });
    if (rootName) setProjectName(rootName);
    setMessage(`Opened ${incoming.length} file${incoming.length === 1 ? '' : 's'}.`);
  }, []);

  const openFiles = async (event) => {
    const selected = [...(event.target.files || [])].filter(file => supportedFiles.test(file.name));
    const entries = await Promise.all(selected.map(async file => ({ name: file.webkitRelativePath || file.name, content: await file.text() })));
    addFiles(entries, event.target.files?.[0]?.webkitRelativePath?.split('/')[0]);
    event.target.value = '';
  };

  const openFilePicker = async () => {
    if (!window.showOpenFilePicker) { filesInputRef.current?.click(); return; }
    try {
      const handles = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'Source files', accept: { 'text/plain': ['.py','.js','.jsx','.ts','.tsx','.java','.c','.h','.cpp','.c++','.hpp','.hxx','.go','.rs','.txt','.md'] } }] });
      const entries = await Promise.all(handles.map(async handle => ({ name: handle.name, content: await (await handle.getFile()).text(), handle })));
      addFiles(entries);
    } catch (error) { if (error.name !== 'AbortError') setMessage(`Open failed: ${error.message}`); }
  };

  const openProjectFolder = async () => {
    if (!window.showDirectoryPicker) { folderInputRef.current?.click(); return; }
    try {
      const root = await window.showDirectoryPicker({ mode: 'read' });
      const entries = [];
      const walk = async (directory, prefix = '') => {
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind === 'directory') {
            if (!['node_modules', '.git', '.venv', 'dist', 'build', '__pycache__'].includes(name)) await walk(handle, `${prefix}${name}/`);
          } else if (supportedFiles.test(name) && entries.length < 500) {
            entries.push({ name: `${prefix}${name}`, content: await (await handle.getFile()).text(), handle });
          }
        }
      };
      await walk(root);
      addFiles(entries, root.name);
      setMessage(`Opened ${entries.length} files from ${root.name}.`);
    } catch (error) { if (error.name !== 'AbortError') setMessage(`Folder open failed: ${error.message}`); }
  };

  const createFile = (fileExtension = 'py') => {
    const newFile = { id: newId(), name: `untitled.${fileExtension}`, content: '', dirty: true, handle: null };
    setFiles(current => [...current, newFile]); setActiveId(newFile.id); setMessage('New file');
  };

  const closeFile = (event, file) => {
    event.stopPropagation();
    if (file.dirty && !window.confirm(`Close ${file.name} with unsaved changes?`)) return;
    setFiles(current => {
      const remaining = current.filter(item => item.id !== file.id);
      if (!remaining.length) {
        const blank = { id: newId(), name: 'main.py', content: '', dirty: false, handle: null };
        setActiveId(blank.id); return [blank];
      }
      if (activeId === file.id) setActiveId(remaining[Math.max(0, current.findIndex(item => item.id === file.id) - 1)].id);
      return remaining;
    });
  };

  const saveFile = async () => {
    if (!activeFile) return;
    try {
      let handle = activeFile.handle;
      if (handle?.queryPermission && await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        if (handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') handle = null;
      }
      if (!handle && window.showSaveFilePicker) handle = await window.showSaveFilePicker({ suggestedName: activeFile.name.split(/[\\/]/).pop() });
      if (handle) {
        const writable = await handle.createWritable(); await writable.write(code); await writable.close();
        setFiles(current => current.map(file => file.id === activeId ? { ...file, handle, dirty: false } : file));
      } else {
        const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([code], { type: 'text/plain' })); link.download = activeFile.name.split(/[\\/]/).pop(); link.click(); URL.revokeObjectURL(link.href);
        setFiles(current => current.map(file => file.id === activeId ? { ...file, dirty: false } : file));
      }
      setMessage('File saved.');
    } catch (error) { if (error.name !== 'AbortError') setMessage(`Save failed: ${error.message}`); }
  };

  const drawCanvas = useCallback(() => {
    const canvas = document.querySelector('.ink-canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * scale) || canvas.height !== Math.round(rect.height * scale)) {
      canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, rect.width, rect.height);
    for (const stroke of strokesRef.current) {
      if (!stroke.points.length) continue;
      ctx.beginPath(); ctx.lineWidth = stroke.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#202420';
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + .1, stroke.points[0].y + .1);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    if (!padOpen) return;
    const frame = requestAnimationFrame(drawCanvas);
    const observer = new ResizeObserver(drawCanvas);
    const pad = document.querySelector('.pad-window');
    if (pad) observer.observe(pad);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [padOpen, recognized, padSize, drawCanvas]);

  const canvasPoint = (event) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const startStroke = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setRecognized('');
    activeStrokeRef.current = { size: penSize, points: [canvasPoint(event)] };
    strokesRef.current = [...strokesRef.current, activeStrokeRef.current]; redoRef.current = []; setHasInk(true); drawCanvas();
  };
  const continueStroke = (event) => {
    if (!activeStrokeRef.current) return;
    activeStrokeRef.current.points.push(canvasPoint(event)); drawCanvas();
  };
  const endStroke = () => { activeStrokeRef.current = null; };
  const undoStroke = () => { if (strokesRef.current.length) { redoRef.current.push(strokesRef.current.pop()); setHasInk(strokesRef.current.length > 0); setRecognized(''); drawCanvas(); } };
  const redoStroke = () => { if (redoRef.current.length) { strokesRef.current.push(redoRef.current.pop()); setHasInk(true); setRecognized(''); drawCanvas(); } };
  const clearPad = () => { strokesRef.current = []; redoRef.current = []; setHasInk(false); setRecognized(''); drawCanvas(); };

  const openPad = () => {
    const editor = editorRef.current;
    if (editor) {
      const position = editor.getPosition();
      anchorRef.current = { fileId: activeId, selection: editor.getSelection(), position };
      const editorRect = editor.getDomNode()?.getBoundingClientRect();
      const cursor = editor.getScrolledVisiblePosition(position);
      let left = editorRect && cursor ? editorRect.left + cursor.left : window.innerWidth - padSize.width - 24;
      let top = editorRect && cursor ? editorRect.top + cursor.top + 28 : 90;
      if (left + padSize.width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - padSize.width - 20);
      if (top + padSize.height > window.innerHeight - 20) top = Math.max(65, window.innerHeight - padSize.height - 24);
      setPadPosition({ left: Math.max(12, left), top: Math.max(65, top) });
    }
    setRecognized(''); strokesRef.current = []; redoRef.current = []; setHasInk(false); setPadOpen(true);
  };

  const beginDrag = (event) => {
    if (event.target.closest('button')) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: padPosition.left, top: padPosition.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePad = (event) => {
    if (dragRef.current) {
      const drag = dragRef.current;
      setPadPosition({ left: Math.min(window.innerWidth - 100, Math.max(0, drag.left + event.clientX - drag.x)), top: Math.min(window.innerHeight - 100, Math.max(58, drag.top + event.clientY - drag.y)) });
    }
    if (resizeRef.current) {
      const resize = resizeRef.current;
      setPadSize({ width: Math.max(430, resize.width + event.clientX - resize.x), height: Math.max(270, resize.height + event.clientY - resize.y) });
    }
  };
  const endPadPointer = () => { dragRef.current = null; resizeRef.current = null; };
  const beginResize = (event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); resizeRef.current = { x: event.clientX, y: event.clientY, width: padSize.width, height: padSize.height }; };

  const recognize = async () => {
    const canvas = document.querySelector('.ink-canvas');
    if (!canvas || !strokesRef.current.length) { setMessage('Write something on the pad first.'); return; }
    const controller = new AbortController(); abortRef.current = controller; setRecognizing(true); setMessage('Reading handwriting with GLM-OCR…');
    try {
      const response = await fetch(`${API}/recognize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: canvas.toDataURL('image/png') }), signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.detail || 'Recognition failed');
      setRecognized(data.text || ''); setMessage(data.text ? 'Review the recognized code before inserting.' : 'No text recognized. Try larger writing with more spacing.');
    } catch (error) {
      if (error.name === 'AbortError') setMessage('Recognition cancelled.');
      else setMessage(error.message || 'Could not reach local OCR.');
    } finally { abortRef.current = null; setRecognizing(false); }
  };
  const cancelRecognition = () => abortRef.current?.abort();
  const closePad = () => { cancelRecognition(); setPadOpen(false); };

  const insertText = () => {
    if (!recognized.trim()) return;
    const editor = editorRef.current; const saved = anchorRef.current;
    if (!editor || !saved) return;
    setActiveId(saved.fileId); editor.focus();
    if (saved.selection) editor.setSelection(saved.selection); else if (saved.position) editor.setPosition(saved.position);
    editor.executeEdits('handwriting-insert', [{ range: editor.getSelection(), text: recognized, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    const value = editor.getValue(); setFiles(current => current.map(file => file.id === saved.fileId ? { ...file, content: value, dirty: true } : file));
    setPadOpen(false); setRecognized(''); setMessage('Handwritten code inserted.');
  };

  const doAction = async (name) => {
    if (!language) { setMessage(`No ${name === 'run' ? 'runner' : 'checker'} is configured for .${extension} files.`); return; }
    setPanel(name === 'run' ? 'terminal' : 'problems'); setActionBusy(true); setMessage(name === 'run' ? `Running ${language}…` : `Checking ${language}…`);
    const model = editorRef.current?.getModel();
    if (name === 'lint' && model && monacoRef.current) monacoRef.current.editor.setModelMarkers(model, 'notebookide', []);
    try {
      const response = await fetch(`${API}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, language }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.detail || `${name} failed`);
      const result = data.output || (data.ok ? 'No issues found.' : ''); setOutput(result);
      if (name === 'lint' && model && monacoRef.current && !data.ok) monacoRef.current.editor.setModelMarkers(model, 'notebookide', lineDiagnostics(result, language, model));
      setMessage(name === 'run' ? `Process finished with exit code ${data.exit_code}.` : (data.ok ? 'Check complete.' : 'Problems found.'));
    } catch (error) { setOutput(error.message || 'Could not reach the local API.'); setMessage(error.message || 'Local API unavailable.'); }
    finally { setActionBusy(false); }
  };

  const checkHealth = async () => {
    try {
      const response = await fetch(`${API}/health`); if (!response.ok) throw new Error('API unavailable');
      const data = await response.json(); setServiceState({ api: 'ready', ollama: data.ollama, model: data.model_ready === 'true' ? 'ready' : 'missing' });
      if (data.model_ready === 'true' && !warmRef.current) {
        warmRef.current = true;
        try { const warmResponse = await fetch(`${API}/warm`, { method: 'POST' }); if (!warmResponse.ok) warmRef.current = false; } catch { warmRef.current = false; }
      }
    } catch { setServiceState({ api: 'offline', ollama: 'offline', model: 'offline' }); }
  };

  useEffect(() => {
    checkHealth();
    const healthTimer = window.setInterval(checkHealth, 30_000);
    const warmTimer = window.setInterval(() => { if (serviceState.model === 'ready') fetch(`${API}/warm`, { method: 'POST' }).catch(() => {}); }, 4 * 60_000);
    return () => { clearInterval(healthTimer); clearInterval(warmTimer); };
  }, [serviceState.model]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape' && padOpen) { closePad(); return; }
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); saveFile(); }
      else if (key === 'i') { event.preventDefault(); openPad(); }
      else if (key === 'k') { event.preventDefault(); doAction('lint'); }
      else if (key === 'enter') { event.preventDefault(); doAction('run'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const monacoLanguage = getEditorLanguage(activeFile?.name || 'main.py');
  const serviceLabel = serviceState.api !== 'ready' ? 'API offline' : serviceState.ollama !== 'ready' ? 'Ollama offline' : serviceState.model !== 'ready' ? `${serviceState.model === 'missing' ? 'Model missing' : 'Model checking'}` : 'GLM-OCR ready';

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Code2 size={19}/><span>✳</span></div><span>NoteBook<span className="brand-accent">IDE</span></span><span className="local-tag"><span/> LOCAL WORKSPACE</span></div>
      <div className="top-actions">
        <button className="icon-button" title="New Python file" onClick={() => createFile('py')}><FilePlus2 size={17}/></button>
        <button className="icon-button" title="Open project folder" onClick={openProjectFolder}><FolderPlus size={17}/></button>
        <button className="icon-button" title="Open files" onClick={openFilePicker}><FolderOpen size={17}/></button>
        <button className={`save-button ${dirty ? 'unsaved' : ''}`} onClick={saveFile}><Save size={15}/> {dirty ? 'Save •' : 'Saved'}</button>
        <input ref={filesInputRef} className="hidden-picker" type="file" accept=".py,.js,.jsx,.ts,.tsx,.java,.c,.h,.cpp,.c++,.hpp,.hxx,.cc,.go,.rs,.txt,.json,.html,.css,.md" multiple onChange={openFiles}/>
        <input ref={folderInputRef} className="hidden-picker" type="file" webkitdirectory="" directory="" multiple onChange={openFiles}/>
      </div>
    </header>
    <div className="workspace">
      <main className="editor-column">
        <div className="tabbar">
          <div className="open-tabs">{files.map(file => { const ext = extensionOf(file.name); return <button key={file.id} className={`open-tab ${file.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(file.id)} title={file.name}><span className="python-icon">{languageBadgeByExtension[ext] || 'Code'}</span><span className="tab-filename">{file.name.split(/[\\/]/).pop()}</span>{file.dirty && <i className="dirty-dot"/>}<span className="tab-close" onClick={event => closeFile(event, file)}><X size={12}/></span></button>; })}</div>
          <div className="editor-tools"><button className="tool-button" onClick={openPad}><Brush size={15}/> Handwrite <span className="shortcut">Ctrl I</span></button><button className="run-button" onClick={() => doAction('run')} disabled={actionBusy || !language}><Play size={14} fill="currentColor"/> Run</button><button className="more-button" onClick={() => doAction('lint')} disabled={!language} title={`Check ${language || extension}`}><span>···</span></button></div>
        </div>
        <div className="editor-wrap"><Editor key={activeFile.id} path={activeFile.name} height="100%" language={monacoLanguage} theme="vs-dark" value={code} onChange={value => setCurrentContent(value || '')} onMount={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; editor.focus(); }} options={{ fontSize: 14, fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace', minimap: { enabled: false }, padding: { top: 22 }, scrollBeyondLastLine: false, renderLineHighlight: 'line', automaticLayout: true, wordWrap: 'off', lineNumbers: 'on', glyphMargin: true, folding: true, tabSize: 4, insertSpaces: true, quickSuggestions: false }} /></div>
        <footer className="statusbar"><div><span className="status-dot"/>{dirty ? 'Unsaved changes' : autosavedAt ? 'Session autosaved' : message}</div><div><span>Ln {editorRef.current?.getPosition()?.lineNumber || 1}, Col {editorRef.current?.getPosition()?.column || 1}</span><span>UTF-8</span><span>{language}</span><span>Ctrl+S Save · Ctrl+I Write · Ctrl+K Check · Ctrl+Enter Run</span></div></footer>
      </main>
      <aside className="right-rail">
        <div className="rail-title">{projectName.toUpperCase()}</div>
        <div className="rail-card"><div className="card-head"><div className="folder-icon"><FolderOpen size={16}/></div><div><b>Project files</b><small>{files.length} open · autosaved locally</small></div><button title="Open folder" onClick={openProjectFolder}><FolderPlus size={15}/></button></div>
          <div className="project-file-list">{files.map(file => <button key={file.id} className={`file-row ${file.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(file.id)} title={file.name}><span className="python-icon">{languageBadgeByExtension[extensionOf(file.name)] || 'Code'}</span><span className="project-path">{file.name}</span>{file.dirty && <i className="dirty-dot"/>}</button>)}</div>
          <label className="new-file"><FilePlus2 size={14}/><span>New file</span><select aria-label="Create a new source file" value="" onChange={event => event.target.value && createFile(event.target.value)}><option value="" disabled>Choose language…</option><option value="py">Python</option><option value="js">JavaScript</option><option value="ts">TypeScript</option><option value="java">Java</option><option value="c">C</option><option value="cpp">C++</option><option value="go">Go</option><option value="rs">Rust</option></select></label>
        </div>
        <div className="rail-section"><div className="rail-section-title">QUICK ACTIONS</div><button onClick={() => doAction('lint')}><span className="action-icon purple">✓</span><span><b>Check code</b><small>Syntax &amp; lint issues</small></span><span className="action-key">Ctrl K</span></button><button onClick={() => doAction('run')}><span className="action-icon green"><Play size={13}/></span><span><b>Run file</b><small>Execute {language} locally</small></span><span className="action-key">Ctrl ↵</span></button><button onClick={openPad}><span className="action-icon orange"><Brush size={14}/></span><span><b>Handwriting pad</b><small>Insert code at cursor</small><span className="action-key">Ctrl I</span></span></button></div>
        <div className="privacy-card"><div className="privacy-icon"><Sparkles size={16}/></div><div><b>Local recognition</b><p>Handwriting stays on this device and uses your Ollama service.</p></div></div>
        <div className="rail-foot"><span className={`ollama-dot ${serviceState.model === 'ready' ? '' : 'offline'}`}/>{serviceLabel}<span className="model-tag">{serviceState.model === 'ready' ? 'GLM-OCR' : 'LOCAL'}</span></div>
      </aside>
    </div>
    <section className="bottom-panel"><div className="panel-tabs"><button className={panel === 'terminal' ? 'selected' : ''} onClick={() => setPanel('terminal')}><Terminal size={14}/> Output</button><button className={panel === 'problems' ? 'selected' : ''} onClick={() => setPanel('problems')}>✓ Problems</button><button className="panel-collapse" onClick={() => setOutput('')}>Clear</button></div><pre className="panel-output">{output}</pre></section>
    {padOpen && <><div className="scrim" onClick={closePad}/><section className="pad-window" style={{ left: padPosition.left, top: padPosition.top, width: padSize.width, height: padSize.height }} onPointerMove={movePad} onPointerUp={endPadPointer} onPointerCancel={endPadPointer}>
      <div className="pad-head" onPointerDown={beginDrag}><div><span className="pad-symbol"><Brush size={15}/></span><b>Handwriting pad</b><span className="pad-hint">Drag to move · write code</span></div><div className="pad-head-actions"><button title="Close" onClick={closePad}><X size={16}/></button></div></div>
      <div className={`pad-body ${recognized ? 'review-layout' : ''}`}>
          <div className="canvas-column"><div className="canvas-wrap"><div className="canvas-lines"/><canvas className="ink-canvas" onPointerDown={startStroke} onPointerMove={continueStroke} onPointerUp={endStroke} onPointerCancel={endStroke}/>{!hasInk && <span className="canvas-prompt">Write your code here…</span>}</div>
          <div className="pad-tools"><button onClick={undoStroke} title="Undo stroke"><Undo2 size={14}/> Undo</button><button onClick={redoStroke} title="Redo stroke"><Redo2 size={14}/> Redo</button><button onClick={clearPad}><Trash2 size={14}/> Clear</button><label className="pen-control">Pen <input type="range" min="1" max="8" step="1" value={penSize} onChange={event => setPenSize(Number(event.target.value))}/><span>{penSize}px</span></label></div>
        </div>
        {recognized !== '' && <div className="recognized"><div className="recognized-title"><span>RECOGNIZED CODE</span><span>Edit before inserting</span></div><textarea value={recognized} onChange={event => setRecognized(event.target.value)} spellCheck="false"/></div>}
      </div>
      <div className="pad-bottom"><div className="pad-service"><span className={`ollama-dot ${serviceState.model === 'ready' ? '' : 'offline'}`}/>{serviceLabel}</div><div className="pad-cta">{recognizing ? <button className="secondary-cta cancel-cta" onClick={cancelRecognition}>Cancel OCR</button> : recognized ? <><button className="secondary-cta" onClick={() => setRecognized('')}>Recognize again</button><button className="primary-cta" onClick={insertText}><Check size={15}/> Insert code</button></> : <button className="primary-cta" onClick={recognize} disabled={serviceState.model !== 'ready'}><Check size={15}/>{serviceState.model === 'ready' ? 'Recognize' : 'Waiting for GLM-OCR'}</button>}</div></div>
      <div className="resize-handle" title="Resize pad" onPointerDown={beginResize}><span/></div>
    </section></>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
