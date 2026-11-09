# Start the existing app locally without changing the production .env file.
# Register http://localhost:8080/api/auth/google/callback in the Google OAuth
# client's authorized redirect URIs before using Google sign-in.
$localOverrides = @{
  NODE_ENV = 'development'
  HOST = '127.0.0.1'
  PORT = '8080'
  GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:8080/api/auth/google/callback'
}
$previousValues = @{}
foreach ($name in $localOverrides.Keys) {
  $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $localOverrides[$name], 'Process')
}
try {
  Push-Location (Join-Path $PSScriptRoot '..')
  try {
    npm start
    $result = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  foreach ($name in $localOverrides.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousValues[$name], 'Process')
  }
}
exit $result
