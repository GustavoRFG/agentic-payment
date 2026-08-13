# TRUSTFORGE — LEGACY MANUAL UI PROBE (FORBIDDEN IN AUTOMATED TESTS)
#
# B.5.0.1: Automated unit/regression suites MUST NOT invoke this script.
# Visible Approve/Reject UI must mean a real human checkpoint.
# Use createTestHumanPaymentDecisionProvider for headless APPROVE/REJECT/ABORT.
#
# This file is retained only for rare offline manual operator probes.
# It is not part of npm test / vitest.
# Do not spawn from TypeScript tests.
#
# ASCII-only. No signer. No payment.
#
# Modes: lifetime | approve | reject | abort
# Usage (manual only):
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File <this> -Mode approve -ProductionScript <path>

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("lifetime", "approve", "reject", "abort")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$ProductionScript,

  [int]$HoldMs = 1500,

  [int]$FindTimeoutMs = 15000
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Write-Harness([string]$line) {
  Write-Output $line
}

if (-not (Test-Path -LiteralPath $ProductionScript)) {
  Write-Harness "HARNESS_FAILED"
  Write-Harness "reason=production_script_missing"
  exit 10
}

# Close any leftover approval windows from prior harness runs (harness-only).
try {
  $root0 = [System.Windows.Automation.AutomationElement]::RootElement
  $cond0 = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "TRUSTFORGE - Payment Approval"
  )
  $leftovers = $root0.FindAll([System.Windows.Automation.TreeScope]::Children, $cond0)
  foreach ($lw in $leftovers) {
    try {
      $wp0 = $lw.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $wp0.Close()
    } catch { }
  }
  Start-Sleep -Milliseconds 200
} catch { }

# Park cursor away from dialog buttons so stray clicks cannot Approve.
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(8, 8)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "powershell.exe"
$psi.Arguments = @(
  "-NoProfile",
  "-STA",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"{0}"' -f $ProductionScript),
  "-ServiceLabel", '"B411 harness probe"',
  "-NetworkLabel", '"Base / eip155:8453"',
  "-Buyer", '"0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1"',
  "-Seller", '"0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea"',
  "-AmountUsdc", '"0.001"',
  "-RequestSummary", '"GET harness (no payment)"'
) -join " "
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $false

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()

$stdoutBuilder = New-Object System.Text.StringBuilder
$stderrBuilder = New-Object System.Text.StringBuilder
$outEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action {
  if ($null -ne $EventArgs.Data) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
} -MessageData $stdoutBuilder
$errEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
  if ($null -ne $EventArgs.Data) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
} -MessageData $stderrBuilder
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

function Find-ApprovalWindow([int]$timeoutMs) {
  $deadline = [Environment]::TickCount + $timeoutMs
  while ([Environment]::TickCount -lt $deadline) {
    if ($proc.HasExited) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      "TRUSTFORGE - Payment Approval"
    )
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($null -ne $win) { return $win }
    Start-Sleep -Milliseconds 100
  }
  return $null
}

function Invoke-Button([System.Windows.Automation.AutomationElement]$win, [string]$name) {
  # WinForms buttons often expose as ControlType.Pane (not Button) under UIA.
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $name
  )
  $deadline = [Environment]::TickCount + 12000
  $btn = $null
  while ([Environment]::TickCount -lt $deadline) {
    $btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($null -ne $btn -and $btn.Current.IsEnabled) { break }
    Start-Sleep -Milliseconds 100
    $btn = $null
  }
  if ($null -eq $btn) { throw "button_not_found_or_disabled:$name" }

  function Test-WindowAlive([System.Windows.Automation.AutomationElement]$w) {
    try { $null = $w.Current.Name; return $true } catch { return $false }
  }

  # Prefer physical click: InvokePattern is unreliable on WinForms Pane proxies.
  try {
    $pt = $btn.GetClickablePoint()
  } catch {
    throw ("no_clickable_point:$name err=" + $_.Exception.Message)
  }
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$pt.X, [int]$pt.Y)
  Start-Sleep -Milliseconds 80
  $typeName = "B411Mouse" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $sig = '[DllImport("user32.dll")] public static extern void mouse_event(int f,int dx,int dy,int d,int e);'
  $m = Add-Type -MemberDefinition $sig -Name $typeName -Namespace "TrustForgeHarness" -PassThru
  $m::mouse_event(0x0002, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 40
  $m::mouse_event(0x0004, 0, 0, 0, 0)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(8, 8)
  Start-Sleep -Milliseconds 200
  if (-not (Test-WindowAlive $win)) { return }

  # Fallback: InvokePattern if click did not close the dialog.
  try {
    $btn2 = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($null -eq $btn2) { return }
    $inv = $btn2.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
  } catch {
    if (-not (Test-WindowAlive $win)) { return }
    throw ("button_click_failed:$name err=" + $_.Exception.Message)
  }
}
function Close-Window([System.Windows.Automation.AutomationElement]$win) {
  $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
  $wp.Close()
}

try {
  $win = Find-ApprovalWindow $FindTimeoutMs
  if ($null -eq $win) {
    Write-Harness "HARNESS_FAILED"
    Write-Harness "reason=dialog_not_found"
    if (-not $proc.HasExited) { $proc.Kill() }
    exit 11
  }

  Write-Harness "dialog_launched=true"
  Start-Sleep -Milliseconds 300

  if ($Mode -eq "lifetime") {
    Start-Sleep -Milliseconds $HoldMs
    if ($proc.HasExited) {
      Write-Harness "HARNESS_FAILED"
      Write-Harness "reason=dialog_closed_without_interaction"
      Write-Harness ("exit_code=" + $proc.ExitCode)
      exit 12
    }
    Write-Harness "dialog_still_open_after_hold=true"
    Write-Harness ("hold_ms=" + $HoldMs)
    Write-Harness "elapsed_time_emitted_decision=false"
    Close-Window $win
  } elseif ($Mode -eq "approve") {
    Invoke-Button $win "APPROVE"
  } elseif ($Mode -eq "reject") {
    Invoke-Button $win "REJECT"
  } elseif ($Mode -eq "abort") {
    Close-Window $win
  }

  if (-not $proc.WaitForExit(30000)) {
    $proc.Kill()
    Write-Harness "HARNESS_FAILED"
    Write-Harness "reason=process_wait_timeout"
    exit 13
  }

  Unregister-Event -SourceIdentifier $outEvent.Name -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier $errEvent.Name -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 100

  $stdout = $stdoutBuilder.ToString()
  $stderr = $stderrBuilder.ToString()
  Write-Harness ("production_exit_code=" + $proc.ExitCode)
  foreach ($line in ($stdout -split "`r?`n")) {
    if ($line.Trim().Length -gt 0) { Write-Harness ("production_stdout=" + $line.Trim()) }
  }
  if ($stderr.Trim().Length -gt 0) {
    Write-Harness ("production_stderr_present=true")
  } else {
    Write-Harness "production_stderr_present=false"
  }
  Write-Harness "signer_invocations=0"
  Write-Harness "payment_bearing_requests=0"
  Write-Harness "HARNESS_OK"
  exit 0
} catch {
  Write-Harness "HARNESS_FAILED"
  Write-Harness ("reason=" + $_.Exception.Message)
  if (-not $proc.HasExited) {
    try { $proc.Kill() } catch { }
  }
  exit 14
}
