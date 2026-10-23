$ErrorActionPreference = 'Stop'
$url = 'http://localhost:8080'

try {
  $null = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
  Start-Process $url
  exit 0
} catch {
  # No server is responding yet; start one below.
}

$command = "cd /d `"$PSScriptRoot`" && if not exist node_modules (npm ci) && npm run dev"
Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', $command) -WindowStyle Normal

for ($attempt = 0; $attempt -lt 90; $attempt++) {
  Start-Sleep -Seconds 2
  try {
    $null = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
    Start-Process $url
    exit 0
  } catch {
    # Wait for dependency installation and Next.js startup.
  }
}

Write-Error 'LibreTV did not become available at http://localhost:8080. Check the opened terminal for errors.'
exit 1
