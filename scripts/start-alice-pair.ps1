# Start Alice and the Telegram bridge in two windows. Both must stay open.
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Start-Logged($name, $npmScript) {
  Start-Process -FilePath "cmd.exe" -WorkingDirectory $Repo -ArgumentList @(
    "/k", "npm run $npmScript"
  ) -WindowStyle Normal
  Write-Host "Opened $name (npm run $npmScript)."
}

Start-Logged "alice" "alice"
Start-Sleep -Seconds 2
Start-Logged "telegram" "telegram"
Write-Host "Alice and Telegram windows are open in $Repo"
