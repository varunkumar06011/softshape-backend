# ─────────────────────────────────────────────────────────────────────────────
# check-unguarded-fetch.ps1 — CI guardrail for unguarded fetch() calls
# ─────────────────────────────────────────────────────────────────────────────
# Scans all .ts files in src/ for raw fetch() calls that don't include
# a signal or AbortSignal.timeout in the same call expression.
#
# Exits 1 if any violations are found, 0 otherwise.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/check-unguarded-fetch.ps1
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$violations = 0
$srcPath = Join-Path $PSScriptRoot ".." "src"
$tsFiles = Get-ChildItem -Path $srcPath -Filter "*.ts" -Recurse | Where-Object { $_.FullName -notmatch "node_modules" }

foreach ($file in $tsFiles) {
    $lines = Get-Content $file.FullName
    $lineNum = 0
    foreach ($line in $lines) {
        $lineNum++
        # Skip lines that don't contain fetch(
        if ($line -notmatch 'fetch\(') { continue }
        # Skip lines that contain signal, AbortSignal, or wrapper names
        if ($line -match 'signal|AbortSignal|cloudFetch|httpFetch|fetchWithRetry') { continue }
        # Skip import lines and comment lines
        if ($line -match '^\s*import|^\s*//|^\s*\*') { continue }
        # Skip type definitions
        if ($line -match '^\s*(type|interface|export)\s') { continue }

        Write-Host "  $($file.Name):$lineNum : $line"
        $script:violations++
    }
}

if ($violations -gt 0) {
    Write-Host ""
    Write-Host "[X] Found $violations unguarded fetch() call(s)."
    Write-Host "    Wrap fetch() with AbortSignal.timeout() or use a shared helper."
    Write-Host "    To suppress: add 'signal: AbortSignal.timeout(...)' to the fetch options."
    exit 1
}

Write-Host "[OK] All fetch() calls are guarded with timeout/signal."
exit 0
