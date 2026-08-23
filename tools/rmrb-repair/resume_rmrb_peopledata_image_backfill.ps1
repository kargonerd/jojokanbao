param(
    [Parameter(Mandatory = $true)]
    [int]$WaitForPid,
    [double]$Delay = 0.6
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$collector = Join-Path $PSScriptRoot 'backfill_rmrb_peopledata_images.py'
$runtime = Join-Path $workspace 'tmp\rmrb-peopledata-online-backfill'
$log = Join-Path $runtime 'retry.stdout.log'
$errorLog = Join-Path $runtime 'retry.stderr.log'

if (Get-Process -Id $WaitForPid -ErrorAction SilentlyContinue) {
    Wait-Process -Id $WaitForPid
}

Push-Location $workspace
try {
    "[$(Get-Date -Format o)] retry ambiguous titles" | Add-Content -Encoding UTF8 $log
    & python $collector --only-status ambiguous_exact_title --delay $Delay 1>>$log 2>>$errorLog
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        "[$(Get-Date -Format o)] retry image downloads pass $attempt" | Add-Content -Encoding UTF8 $log
        & python $collector --only-status image_download_error --delay $Delay 1>>$log 2>>$errorLog
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
}
finally {
    Pop-Location
    Remove-Item Env:JOJO_PEOPLEDATA_COOKIE -ErrorAction SilentlyContinue
}
