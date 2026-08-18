param(
    [double]$Delay = 0.6,
    [int]$PageSize = 200
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$collector = Join-Path $PSScriptRoot 'backfill_rmrb_peopledata_images.py'
$runtime = Join-Path $workspace 'tmp\rmrb-peopledata-online-backfill'
[IO.Directory]::CreateDirectory($runtime) | Out-Null

Write-Host '请粘贴已登录 WebVPN 请求中的完整 Cookie 请求头值。Cookie 只传给本次子进程，不写入文件。'
$secureCookie = Read-Host 'Cookie' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCookie)
try {
    $plainCookie = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plainCookie)) {
        throw 'Cookie 不能为空。'
    }
    $env:JOJO_PEOPLEDATA_COOKIE = $plainCookie
    $stdout = Join-Path $runtime 'scan.stdout.log'
    $stderr = Join-Path $runtime 'scan.stderr.log'
    $arguments = @(
        $collector,
        '--delay', $Delay.ToString([Globalization.CultureInfo]::InvariantCulture),
        '--page-size', $PageSize.ToString()
    )
    $process = Start-Process -FilePath 'python' -ArgumentList $arguments `
        -WorkingDirectory $workspace -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    [IO.File]::WriteAllText((Join-Path $runtime 'scan.pid'), [string]$process.Id)
    $retryScript = Join-Path $PSScriptRoot 'resume_rmrb_peopledata_image_backfill.ps1'
    $supervisor = Start-Process -FilePath 'pwsh' -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $retryScript,
        '-WaitForPid', $process.Id,
        '-Delay', $Delay.ToString([Globalization.CultureInfo]::InvariantCulture)
    ) -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText((Join-Path $runtime 'retry.pid'), [string]$supervisor.Id)
}
finally {
    Remove-Item Env:JOJO_PEOPLEDATA_COOKIE -ErrorAction SilentlyContinue
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

Write-Host "扫描已在后台启动，PID=$($process.Id)"
Write-Host "自动复扫监督进程，PID=$($supervisor.Id)"
Write-Host "进度日志：$stdout"
Write-Host "错误日志：$stderr"
Write-Host "汇总：$workspace\tmp\rmrb-peopledata-full-directory\peopledata-image-backfill-summary.json"
