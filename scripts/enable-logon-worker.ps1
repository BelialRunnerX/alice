# Register a logon task that starts the My Machines worker.
# Run this once yourself when you want the worker after every sign-in:
#   powershell -ExecutionPolicy Bypass -File scripts\enable-logon-worker.ps1
$ErrorActionPreference = "Stop"
$Script = (Resolve-Path (Join-Path $PSScriptRoot "start-worker.ps1")).Path
$Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Script`""
schtasks /Create /TN "AliceLaptopWorker" /SC ONLOGON /RL LIMITED /F /TR $Action
Write-Host "Logon task AliceLaptopWorker is enabled. Disable with: schtasks /Delete /TN AliceLaptopWorker /F"
