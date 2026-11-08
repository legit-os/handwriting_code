param(
    [switch]$WithOllama
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontend = Join-Path $root 'frontend'
$logDirectory = Join-Path $root '.notebookide\logs'
$apiHealthUrl = 'http://127.0.0.1:8765/api/health'
$uiUrl = 'http://127.0.0.1:5173'
$ollamaUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL.TrimEnd('/') } else { 'http://127.0.0.1:11434' }
$ollamaTagsUrl = "$ollamaUrl/api/tags"
$modelName = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'glm-ocr:latest' }

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Get-HttpJson([string]$Uri) {
    try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 3 } catch { return $null }
}

function Wait-ForEndpoint([string]$Uri, [int]$Attempts = 25) {
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $response = Get-HttpJson $Uri
        if ($null -ne $response) { return $response }
        Start-Sleep -Seconds 1
    }
    return $null
}

function Start-LoggedProcess([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$LogName) {
    $stdoutPath = Join-Path $logDirectory "$LogName.log"
    $stderrPath = Join-Path $logDirectory "$LogName-error.log"
    Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
    return Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
}

function Get-OllamaCli {
    $command = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $localInstall = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $localInstall) { return $localInstall }
    return $null
}

function Start-OllamaIfRequested {
    $ollamaStatus = Get-HttpJson $ollamaTagsUrl
    $ollamaCli = Get-OllamaCli
    $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    $dockerContainer = $false

    if ($null -eq $ollamaStatus) {
        if ($ollamaCli) {
            Write-Host 'Starting Ollama…'
            Start-LoggedProcess -FilePath $ollamaCli -Arguments @('serve') -WorkingDirectory $root -LogName 'ollama' | Out-Null
        } elseif ($dockerCommand) {
            $inspect = & $dockerCommand.Source inspect ollama 2>$null
            if ($LASTEXITCODE -eq 0) {
                & $dockerCommand.Source start ollama | Out-Null
            } else {
                Write-Host 'Creating the Ollama Docker container…'
                & $dockerCommand.Source run -d --name ollama -v ollama:/root/.ollama -p 11434:11434 ollama/ollama | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Could not start an Ollama Docker container. Check that Docker Desktop is running.' }
            }
            $dockerContainer = $true
        } else {
            throw 'Ollama is not reachable and neither the Ollama CLI nor Docker is installed. Install Ollama, or start it manually, then retry.'
        }

        $ollamaStatus = Wait-ForEndpoint $ollamaTagsUrl 45
        if ($null -eq $ollamaStatus) { throw "Ollama did not become ready at $ollamaUrl. Check the Ollama or Docker logs." }
    } elseif (-not $ollamaCli -and $dockerCommand) {
        $dockerContainer = $true
    }

    $hasModel = @($ollamaStatus.models | Where-Object { $_.name -eq $modelName -or $_.name.Split(':')[0] -eq $modelName.Split(':')[0] }).Count -gt 0
    if (-not $hasModel) {
        Write-Host "Downloading $modelName… (this can take a while)"
        if ($ollamaCli) {
            & $ollamaCli pull $modelName
            if ($LASTEXITCODE -ne 0) { throw "Could not download $modelName with Ollama." }
        } elseif ($dockerContainer) {
            & $dockerCommand.Source exec ollama ollama pull $modelName
            if ($LASTEXITCODE -ne 0) { throw "Could not download $modelName in the Ollama container." }
        } else {
            throw "Ollama is running, but $modelName is missing and no Ollama CLI or Docker command is available to download it."
        }
    }
    Write-Host "Ollama is ready with $modelName."
}

try {
    if ($WithOllama) { Start-OllamaIfRequested }
    elseif ($null -eq (Get-HttpJson $ollamaTagsUrl)) {
        Write-Host 'Ollama is not running. The editor will open, but handwriting OCR will remain offline.'
        Write-Host 'To start Ollama automatically next time, launch with -WithOllama.'
    }

    $pythonPath = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $pythonPath)) {
        $uvCommand = Get-Command uv.exe -ErrorAction SilentlyContinue
        if ($uvCommand) {
            Write-Host 'Creating the Python environment with uv…'
            & $uvCommand.Source venv (Join-Path $root '.venv')
        } else {
            $pyCommand = Get-Command py.exe -ErrorAction SilentlyContinue
            if (-not $pyCommand) { throw 'Install Python 3.12 or newer, or install uv, then run this launcher again.' }
            Write-Host 'Creating the Python environment with Python…'
            & $pyCommand.Source -3.12 -m venv (Join-Path $root '.venv')
        }
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
    }

    & $pythonPath -c 'import fastapi, httpx, uvicorn' *> $null
    if ($LASTEXITCODE -ne 0) {
        $uvCommand = Get-Command uv.exe -ErrorAction SilentlyContinue
        Write-Host 'Installing backend packages…'
        if ($uvCommand) {
            & $uvCommand.Source pip install --python $pythonPath -r (Join-Path $root 'backend\requirements.txt')
        } else {
            & $pythonPath -m pip install -r (Join-Path $root 'backend\requirements.txt')
        }
        if ($LASTEXITCODE -ne 0) { throw 'Could not install backend packages.' }
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { throw 'Node.js and npm are required to launch the UI.' }
    if (-not (Test-Path -LiteralPath (Join-Path $frontend 'node_modules\vite\bin\vite.js'))) {
        Write-Host 'Installing frontend packages…'
        Push-Location $frontend
        try { & $npmCommand.Source ci; if ($LASTEXITCODE -ne 0) { throw 'Could not install frontend packages.' } }
        finally { Pop-Location }
    }

    if ($null -eq (Get-HttpJson $apiHealthUrl)) {
        Write-Host 'Starting the NoteBookIDE API…'
        Start-LoggedProcess -FilePath $pythonPath -Arguments @('-m','uvicorn','backend.app:app','--host','127.0.0.1','--port','8765') -WorkingDirectory $root -LogName 'api' | Out-Null
        if ($null -eq (Wait-ForEndpoint $apiHealthUrl 25)) {
            $errorLog = Join-Path $logDirectory 'api-error.log'
            $details = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Raw } else { 'No API startup log was created.' }
            throw "The NoteBookIDE API did not start. See .notebookide\logs\api-error.log.`n$details"
        }
    } else {
        Write-Host 'NoteBookIDE API is already running.'
    }

    if ($null -eq (Get-HttpJson $uiUrl)) {
        Write-Host 'Starting the NoteBookIDE UI…'
        Start-LoggedProcess -FilePath $npmCommand.Source -Arguments @('run','dev','--','--host','127.0.0.1','--strictPort') -WorkingDirectory $frontend -LogName 'frontend' | Out-Null
        if ($null -eq (Wait-ForEndpoint $uiUrl 25)) {
            $errorLog = Join-Path $logDirectory 'frontend-error.log'
            $details = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Raw } else { 'No frontend startup log was created.' }
            throw "The NoteBookIDE UI did not start. See .notebookide\logs\frontend-error.log.`n$details"
        }
    } else {
        Write-Host 'NoteBookIDE UI is already running.'
    }

    Write-Host "Opening $uiUrl"
    Start-Process $uiUrl
    Write-Host "Logs: $logDirectory"
} catch {
    Write-Host "`nNoteBookIDE could not start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
