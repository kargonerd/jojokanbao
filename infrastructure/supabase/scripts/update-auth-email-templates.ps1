param(
  [string]$EnvFile
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
if (-not $EnvFile) {
  $EnvFile = Join-Path $repositoryRoot ".env"
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Environment file not found: $EnvFile"
}

$lines = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' }
$config = ConvertFrom-StringData ($lines -join [Environment]::NewLine)
if (-not $config.SUPABASE_ACCESS_TOKEN -or -not $config.SUPABASE_PROJECT_REF) {
  throw "SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required."
}

$templateRoot = Join-Path $PSScriptRoot "..\templates"
$payload = [ordered]@{
  mailer_subjects_confirmation = "{{ .Token }} 是你的 JOJO 注册验证码"
  mailer_templates_confirmation_content = Get-Content -Raw -LiteralPath (Join-Path $templateRoot "confirmation.html")
  mailer_subjects_recovery = "{{ .Token }} 是你的 JOJO 密码重置验证码"
  mailer_templates_recovery_content = Get-Content -Raw -LiteralPath (Join-Path $templateRoot "recovery.html")
  mailer_subjects_reauthentication = "{{ .Token }} 是你的 JOJO 身份验证码"
  mailer_templates_reauthentication_content = Get-Content -Raw -LiteralPath (Join-Path $templateRoot "reauthentication.html")
  mailer_subjects_password_changed_notification = "你的 JOJO 账号密码已修改"
  mailer_templates_password_changed_notification_content = Get-Content -Raw -LiteralPath (Join-Path $templateRoot "password_changed_notification.html")
}

$headers = @{ Authorization = "Bearer $($config.SUPABASE_ACCESS_TOKEN)" }
$uri = "https://api.supabase.com/v1/projects/$($config.SUPABASE_PROJECT_REF)/config/auth"
Invoke-RestMethod -Headers $headers -Uri $uri -Method Patch -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 4 -Compress) | Out-Null
Write-Output "Updated JOJO authentication email templates for project $($config.SUPABASE_PROJECT_REF)."
