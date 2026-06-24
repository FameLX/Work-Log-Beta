# Claude Code - Permission Notifier (WinForms popup, bottom-right, no focus steal)
# Hook fires this via PreToolUse. Exit 0 = allow, Exit 2 = deny.
# Nothing installed. To remove: delete this file + remove the hooks block from settings.local.json.

param()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# P/Invoke to show window without stealing focus
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinHelper {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const int SW_SHOWNOACTIVATE = 4;
}
"@

# --- Read stdin (from Claude Code hook — plain JSON) ---
$toolName = "Unknown"
$detail   = "Claude Code wants to perform an action."
try {
    # Try $input first (PS-to-PS pipeline), fall back to Console.In (Node.js/direct)
    $raw = if ($input) { $input | Out-String } else { [Console]::In.ReadToEnd() }
    # Strip CLIXML wrapper if invoked from a PS pipeline during testing
    if ($raw -match '<S>(\{.*\})</S>') { $raw = $Matches[1] }
    $info = $raw | ConvertFrom-Json
    $toolName = $info.tool_name
    $inp  = $info.tool_input
    $detail = switch ($toolName) {
        "Bash"     { "Run: $($inp.command)" }
        "Write"    { "Write: $($inp.file_path)" }
        "Edit"     { "Edit: $($inp.file_path)" }
        "WebFetch" { "Fetch: $($inp.url)" }
        default    { "Tool: $toolName" }
    }
    if ($detail.Length -gt 100) { $detail = $detail.Substring(0, 97) + "..." }
} catch { }

# Auto-allow all read-only and routine tools silently
$safelist = @("Read","Glob","Grep","TodoWrite","TodoRead","LS","ListFiles",
              "WebSearch","WebFetch","Edit","Write","Bash","PowerShell")
if ($safelist -contains $toolName) {
    # For Bash/PowerShell, only interrupt on genuinely destructive patterns
    if ($toolName -in @("Bash","PowerShell")) {
        $cmd = "$($info.tool_input.command)$($info.tool_input.script)"
        $dangerous = $cmd -match '(?i)(\brm\s+-[rRfF]|\brmdir\b|\bdel\s+/[sS]|\bgit\s+push.*--force|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[fd]|\bgit\s+branch\s+-[dD]\b|Remove-Item.*-Recurse|\bdrop\s+table\b|\btruncate\s+table\b|\btaskkill\b|\bkill\s+-9\b|npm\s+install\s+-g\b|pip\s+install\b|--force\b)'
        if (-not $dangerous) { exit 0 }
    } else {
        exit 0
    }
}

# --- Build the form ---
$TIMEOUT = 30   # seconds before auto-deny

$form = New-Object System.Windows.Forms.Form
$form.Text            = ""
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.Width           = 370
$form.Height          = 130
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.BackColor       = [System.Drawing.Color]::FromArgb(243, 243, 243)
$form.Opacity         = 0.95
$form.StartPosition   = [System.Windows.Forms.FormStartPosition]::Manual

# Position bottom-right (above taskbar) — recalculate after form is sized
$form.Add_Load({
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Left = $wa.Right  - $form.Width  - 16
    $form.Top  = $wa.Bottom - $form.Height - 16
})

# Thin accent border (top)
$accent = New-Object System.Windows.Forms.Panel
$accent.BackColor = [System.Drawing.Color]::FromArgb(255, 149, 0)   # orange
$accent.Dock = [System.Windows.Forms.DockStyle]::Top
$accent.Height = 3
$form.Controls.Add($accent)

# Title label
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text      = "Claude Code - Permission Request"
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(26, 26, 26)
$lblTitle.Font      = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$lblTitle.SetBounds(12, 12, 346, 20)
$form.Controls.Add($lblTitle)

# Detail label
$lblDetail = New-Object System.Windows.Forms.Label
$lblDetail.Text      = $detail
$lblDetail.ForeColor = [System.Drawing.Color]::FromArgb(85, 85, 85)
$lblDetail.Font      = New-Object System.Drawing.Font("Segoe UI", 8.5)
$lblDetail.SetBounds(12, 34, 346, 32)
$form.Controls.Add($lblDetail)

# Allow button
$btnAllow = New-Object System.Windows.Forms.Button
$btnAllow.Text      = "Allow"
$btnAllow.SetBounds(12, 76, 90, 32)
$btnAllow.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnAllow.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(255, 149, 0)
$btnAllow.BackColor  = [System.Drawing.Color]::FromArgb(255, 149, 0)
$btnAllow.ForeColor  = [System.Drawing.Color]::Black
$btnAllow.Font       = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnAllow)

# Deny button
$btnDeny = New-Object System.Windows.Forms.Button
$btnDeny.Text      = "Deny"
$btnDeny.SetBounds(110, 76, 90, 32)
$btnDeny.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnDeny.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
$btnDeny.BackColor  = [System.Drawing.Color]::FromArgb(224, 224, 224)
$btnDeny.ForeColor  = [System.Drawing.Color]::FromArgb(40, 40, 40)
$btnDeny.Font       = New-Object System.Drawing.Font("Segoe UI", 8.5)
$form.Controls.Add($btnDeny)

# Countdown label
$lblTimer = New-Object System.Windows.Forms.Label
$lblTimer.Text      = "Auto-deny in ${TIMEOUT}s"
$lblTimer.ForeColor = [System.Drawing.Color]::FromArgb(100, 100, 100)
$lblTimer.Font      = New-Object System.Drawing.Font("Segoe UI", 7.5)
$lblTimer.SetBounds(210, 84, 150, 18)
$form.Controls.Add($lblTimer)

# --- Result tracking ---
$script:result = "deny"

$btnAllow.Add_Click({ $script:result = "allow"; $form.Close() })
$btnDeny.Add_Click({  $script:result = "deny";  $form.Close() })

# Countdown timer
$remaining = $TIMEOUT
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    $script:remaining--
    $lblTimer.Text = "Auto-deny in ${script:remaining}s"
    if ($script:remaining -le 0) { $timer.Stop(); $form.Close() }
})
$script:remaining = $TIMEOUT
$timer.Start()

# Show without stealing focus
$form.Add_Shown({
    [WinHelper]::SetWindowPos(
        $form.Handle,
        [WinHelper]::HWND_TOPMOST,
        0, 0, 0, 0,
        [WinHelper]::SWP_NOACTIVATE -bor [WinHelper]::SWP_NOMOVE -bor [WinHelper]::SWP_NOSIZE
    ) | Out-Null
})

[System.Windows.Forms.Application]::Run($form)

$timer.Stop()
$timer.Dispose()
$form.Dispose()

if ($script:result -eq "allow") { exit 0 } else { exit 2 }
