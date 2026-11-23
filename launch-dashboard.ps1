# Opens the Nashoba Power Wash dashboard in its own app window.
# Starts the local server silently if needed; the server stops by itself a few minutes after the window closes.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url  = 'http://127.0.0.1:3000'

function Test-Server { try { Invoke-WebRequest -UseBasicParsing "$url/api/ping" -TimeoutSec 2 | Out-Null; $true } catch { $false } }

if (-not (Test-Server)) {
  Start-Process -FilePath 'node' -ArgumentList 'server/server.js', '--app' -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Server)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("The dashboard server didn't start. Open a terminal in`n$root`nand run: npm start", 'Nashoba Dashboard') | Out-Null
    exit 1
  }
}

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$url", '--window-size=1400,900'
} else {
  Start-Process $url  # fallback: default browser
}
