# TRUSTFORGE B.4.1 / B.5.2 - Approve / Reject payment dialog (explicit decisions only)
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
  [Parameter(Mandatory = $true)][string]$RequestSummary,
  [Parameter(Mandatory = $false)][string]$DialogTitle = "TRUSTFORGE - Payment Approval",
  [Parameter(Mandatory = $false)][string]$Method = "",
  [Parameter(Mandatory = $false)][string]$AdvertisedPurpose = "",
  [Parameter(Mandatory = $false)][string]$PurposeQualityNote = "",
  [Parameter(Mandatory = $false)][string]$WhySelected = "",
  [Parameter(Mandatory = $false)][string]$KnownFacts = "",
  [Parameter(Mandatory = $false)][string]$UnknownFacts = "",
  [Parameter(Mandatory = $false)][string]$IntentHash = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# explicit_source: none | approve_button | reject_button | window_close | keyboard_close
$script:explicitSource = "none"

$form = New-Object System.Windows.Forms.Form
$form.Text = $DialogTitle
$form.Size = New-Object System.Drawing.Size(640, 720)
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

$y = 12
function Add-Label([string]$text, [int]$height = 20, [bool]$bold = $false) {
  $script:label = New-Object System.Windows.Forms.Label
  $script:label.Location = New-Object System.Drawing.Point(16, $script:y)
  $script:label.Size = New-Object System.Drawing.Size(600, $height)
  $script:label.Text = $text
  if ($bold) {
    $script:label.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
  } else {
    $script:label.Font = New-Object System.Drawing.Font("Segoe UI", 9)
  }
  $form.Controls.Add($script:label)
  $script:y += ($height + 4)
}

Add-Label $DialogTitle 28 $true
Add-Label "Service:`r`n$ServiceLabel" 36
if ($AdvertisedPurpose -ne "") {
  Add-Label "Advertised purpose:`r`n$AdvertisedPurpose" 40
}
if ($PurposeQualityNote -ne "") {
  Add-Label "Important:`r`n$PurposeQualityNote" 40 $true
}
Add-Label "Network: $NetworkLabel" 20
if ($Method -ne "") {
  Add-Label "Method: $Method" 20 $true
}
Add-Label "Request:`r`n$RequestSummary" 40
Add-Label "Cost: $AmountUsdc USDC" 22 $true
Add-Label "Seller:`r`n$Seller" 36
Add-Label "Buyer:`r`n$Buyer" 36
if ($WhySelected -ne "") {
  Add-Label "Why selected:`r`n$WhySelected" 48
}
if ($KnownFacts -ne "") {
  Add-Label "Known:`r`n$KnownFacts" 56
}
if ($UnknownFacts -ne "") {
  Add-Label "Unknown:`r`n$UnknownFacts" 48
}
Add-Label "Execution: 1 signature | 1 payment | NO RETRY | NO RESEND" 28
if ($IntentHash -ne "") {
  Add-Label ("Intent hash: " + $IntentHash.Substring(0, [Math]::Min(16, $IntentHash.Length)) + "...") 20
}
Add-Label "Close (X) aborts without approving or rejecting." 20

$btnReject = New-Object System.Windows.Forms.Button
$btnReject.Location = New-Object System.Drawing.Point(340, 640)
$btnReject.Size = New-Object System.Drawing.Size(110, 32)
$btnReject.Text = "REJECT"
# No DialogResult - only Click handler may mark reject_button.

$btnApprove = New-Object System.Windows.Forms.Button
$btnApprove.Location = New-Object System.Drawing.Point(466, 640)
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
