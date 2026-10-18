# Keep this laptop awake and connected as My Machines worker "alice-laptop".
# Leave the window open. Closing it drops the machine from cursor.com/agents.
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$agent = Join-Path $env:USERPROFILE ".local\bin\agent.exe"
if (-not (Test-Path $agent)) {
  $cmd = Get-Command agent -ErrorAction SilentlyContinue
  if ($cmd) { $agent = $cmd.Source } else { throw "Cursor CLI is not installed. Run: irm 'https://cursor.com/install?win32=true' | iex" }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AliceAwake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
[AliceAwake]::SetThreadExecutionState([uint32]0x80000000 -bor [uint32]0x00000001 -bor [uint32]0x00000040) | Out-Null

Write-Host "Starting alice-laptop for $Repo"
Write-Host "Plug the laptop in. This process must stay running."
& $agent worker start --name "alice-laptop" --worker-dir $Repo
exit $LASTEXITCODE
