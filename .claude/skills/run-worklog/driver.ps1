# worklog driver — opens the app in Chrome with remote debugging and drives it via CDP
# Usage:
#   .\driver.ps1 screenshot [out.png]
#   .\driver.ps1 eval      "<JS expression>"
#   .\driver.ps1 click     "<CSS selector>"
#   .\driver.ps1 set       "<CSS selector>" "<value>"
#   .\driver.ps1 add-entry "<name>" [type] [deadline-YYYY-MM-DD]
#   .\driver.ps1 count                        # print entry count
#   .\driver.ps1 stop                         # kill the debug Chrome

param(
    [Parameter(Position=0)] [string]$Op = "screenshot",
    [Parameter(Position=1)] [string]$Arg1 = "C:\Temp\worklog-screenshot.png",
    [Parameter(Position=2)] [string]$Arg2 = "",
    [Parameter(Position=3)] [string]$Arg3 = ""
)

$CHROME   = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$APP_URL  = "file:///C:/Users/Uesr01/Desktop/Work%20Files/AI/worklog.html"
$DEBUG_PORT = 9222
$USER_DIR = "C:\Temp\chrome-worklog-debug"
$CDP_EXE  = "$PSScriptRoot\cdp.exe"

function Get-WorkLogTab {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$DEBUG_PORT/json" -UseBasicParsing -TimeoutSec 3
        $tabs = $resp.Content | ConvertFrom-Json
        return ($tabs | Where-Object { $_.title -eq "Work Log" -and $_.type -eq "page" } | Select-Object -First 1)
    } catch { return $null }
}

function Ensure-Running {
    $tab = Get-WorkLogTab
    if ($tab) { return $tab.webSocketDebuggerUrl }

    # Launch Chrome with debug port
    Start-Process $CHROME -ArgumentList @(
        "--remote-debugging-port=$DEBUG_PORT",
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=$USER_DIR",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--window-size=1400,900",
        $APP_URL
    )

    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep 1
        $tab = Get-WorkLogTab
        if ($tab) { return $tab.webSocketDebuggerUrl }
    }
    throw "Work Log tab did not appear within 15 seconds"
}

# Stop command — kill debug Chrome
if ($Op -eq "stop") {
    Get-Process chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$DEBUG_PORT*" } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Output "stopped"
    exit 0
}

$ws = Ensure-Running

switch ($Op) {
    "screenshot" {
        $out = if ($Arg1) { $Arg1 } else { "C:\Temp\worklog-screenshot.png" }
        & $CDP_EXE $ws "screenshot" $out
    }
    "eval" {
        & $CDP_EXE $ws "eval" "nul" $Arg1
    }
    "click" {
        & $CDP_EXE $ws "click" "nul" $Arg1
    }
    "set" {
        & $CDP_EXE $ws "set" "nul" $Arg1 $Arg2
    }
    "count" {
        & $CDP_EXE $ws "eval" "nul" "entries.length"
    }
    "add-entry" {
        $name     = $Arg1
        $type     = if ($Arg2) { $Arg2 } else { "" }
        $deadline = if ($Arg3) { $Arg3 } else { "" }

        # Fill work name
        & $CDP_EXE $ws "set" "nul" "#f-name" $name
        Start-Sleep -Milliseconds 200

        # Set type if provided
        if ($type) {
            & $CDP_EXE $ws "eval" "nul" "(function(){var s=document.querySelector('#f-type');s.value='$type';s.dispatchEvent(new Event('change',{bubbles:true}));})()"
            Start-Sleep -Milliseconds 100
        }

        # Set deadline if provided (event mode: start date field)
        if ($deadline) {
            & $CDP_EXE $ws "eval" "nul" "(function(){var d=document.querySelector('#f-deadline');d.value='$deadline';d.dispatchEvent(new Event('change',{bubbles:true}));})()"
            Start-Sleep -Milliseconds 100
        }

        # Click Add entry
        & $CDP_EXE $ws "click" "nul" ".btn-primary"
        Start-Sleep -Milliseconds 500

        $count = & $CDP_EXE $ws "eval" "nul" "entries.length"
        Write-Output "Entry added. Total entries: $count"
    }
    default {
        Write-Output "Unknown op: $Op"
        exit 1
    }
}
