# TRUSTFORGE B.4.1 / B.4.1.1 - Approve / Reject payment dialog (explicit decisions only)
# Args are public economics only. Never pass secrets.
#
# This file MUST remain ASCII-only (bytes 0x00-0x7F) so Windows PowerShell 5.1
# can parse it under the legacy system code page without a UTF-8 BOM.
#
# Exit codes (stdout line is the machine token):
#   0 APPROVE          - APPROVE button only
#   2 REJECT           - REJECT button only
#   3 ABORT            - window X / Alt+F4 / Esc / non-button close
#   4 UI_FAILED        - unexpected UI/process failure
#
# No automatic timeout. Never closes or submits without a human click.
# ShowDialog blocks until an explicit human interaction.
# Production has no harness flags and no synthetic decision callbacks.

param(
  [Parameter(Mandatory = $true)][string]$ServiceLabel,
  [Parameter(Mandatory = $true)][string]$NetworkLabel,
  [Parameter(Mandatory = $true)][string]$Buyer,
  [Parameter(Mandatory = $true)][string]$Seller,
  [Parameter(Mandatory = $true)][string]$AmountUsdc,
  [Parameter(Mandatory = $true)][string]$RequestSummary
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# explicit_source: none | approve_button | reject_button | window_close | keyboard_close
$script:explicitSource = "none"

$form = New-Object System.Windows.Forms.Form
$form.Text = "TRUSTFORGE - Payment Approval"
$form.Size = New-Object System.Drawing.Size(560, 440)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.KeyPreview = $true
# Do NOT set AcceptButton / CancelButton - Enter/Esc must not synthesize Approve/Reject.
$form.AcceptButton = $null
$form.CancelButton = $null

$y = 16
function Add-Label([string]$text, [int]$height = 20, [bool]$bold = $false) {
  $script:label = New-Object System.Windows.Forms.Label
  $script:label.Location = New-Object System.Drawing.Point(16, $script:y)
  $script:label.Size = New-Object System.Drawing.Size(520, $height)
  $script:label.Text = $text
  if ($bold) {
    $script:label.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
  } else {
    $script:label.Font = New-Object System.Drawing.Font("Segoe UI", 9)
  }
  $form.Controls.Add($script:label)
  $script:y += ($height + 6)
}

Add-Label "TRUSTFORGE - Payment Approval" 24 $true
Add-Label "Service:`r`n$ServiceLabel" 36
Add-Label "Network: $NetworkLabel" 20
Add-Label "Buyer:`r`n$Buyer" 36
Add-Label "Seller:`r`n$Seller" 36
Add-Label "Amount: $AmountUsdc USDC" 24 $true
Add-Label "Request:`r`n$RequestSummary" 36
Add-Label "Policy: 1 attempt | 1 signature | 1 payment | NO RETRY | NO RESEND" 36
Add-Label "Close (X) aborts without approving or rejecting." 20

$btnReject = New-Object System.Windows.Forms.Button
$btnReject.Location = New-Object System.Drawing.Point(280, 360)
$btnReject.Size = New-Object System.Drawing.Size(110, 32)
$btnReject.Text = "REJECT"
# No DialogResult - only Click handler may mark reject_button.

$btnApprove = New-Object System.Windows.Forms.Button
$btnApprove.Location = New-Object System.Drawing.Point(406, 360)
$btnApprove.Size = New-Object System.Drawing.Size(110, 32)
$btnApprove.Text = "APPROVE"
$btnApprove.Enabled = $true
$btnReject.Enabled = $true
# No DialogResult - only Click handler may mark approve_button.

$btnApprove.Add_Click({
  $script:explicitSource = "approve_button"
  $form.Close()
})
$btnReject.Add_Click({
  $script:explicitSource = "reject_button"
  $form.Close()
})

$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
    $script:explicitSource = "keyboard_close"
    $e.Handled = $true
    $form.Close()
  }
})

$form.Add_FormClosing({
  param($sender, $e)
  if ($script:explicitSource -eq "none") {
    # X / Alt+F4 / system close without button click.
    $script:explicitSource = "window_close"
  }
})

$form.Controls.Add($btnReject)
$form.Controls.Add($btnApprove)
# Focus a non-button label so Enter cannot activate APPROVE/REJECT.
$form.ActiveControl = $script:label

$form.Add_Shown({
  $form.Activate()
  $form.BringToFront()
  $form.TopMost = $true
  $form.TopMost = $false
  $form.TopMost = $true
})

try {
  [void]$form.ShowDialog()
} catch {
  Write-Output "UI_FAILED"
  Write-Output ("decision_source=ui_failure")
  exit 4
}

switch ($script:explicitSource) {
  "approve_button" {
    Write-Output "APPROVE"
    Write-Output "decision_source=approve_button"
    exit 0
  }
  "reject_button" {
    Write-Output "REJECT"
    Write-Output "decision_source=reject_button"
    exit 2
  }
  "keyboard_close" {
    Write-Output "ABORT"
    Write-Output "decision_source=keyboard_close"
    exit 3
  }
  "window_close" {
    Write-Output "ABORT"
    Write-Output "decision_source=window_close"
    exit 3
  }
  default {
    Write-Output "UI_FAILED"
    Write-Output "decision_source=ui_failure"
    exit 4
  }
}
