# TRUSTFORGE B.4 — Approve / Reject payment dialog
# Args are public economics only. Never pass secrets.
# Exit: 0 = APPROVE (stdout: APPROVE), 2 = REJECT, 3 = CLOSED

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

$form = New-Object System.Windows.Forms.Form
$form.Text = "TRUSTFORGE — Payment Approval"
$form.Size = New-Object System.Drawing.Size(560, 420)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
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

Add-Label "TRUSTFORGE — Payment Approval" 24 $true
Add-Label "Service:`r`n$ServiceLabel" 36
Add-Label "Network: $NetworkLabel" 20
Add-Label "Buyer:`r`n$Buyer" 36
Add-Label "Seller:`r`n$Seller" 36
Add-Label "Amount: $AmountUsdc USDC" 24 $true
Add-Label "Request:`r`n$RequestSummary" 36
Add-Label "Policy: 1 attempt · 1 signature · 1 payment · NO RETRY · NO RESEND" 36

$btnReject = New-Object System.Windows.Forms.Button
$btnReject.Location = New-Object System.Drawing.Point(280, 340)
$btnReject.Size = New-Object System.Drawing.Size(110, 32)
$btnReject.Text = "REJECT"
$btnReject.DialogResult = [System.Windows.Forms.DialogResult]::Abort

$btnApprove = New-Object System.Windows.Forms.Button
$btnApprove.Location = New-Object System.Drawing.Point(406, 340)
$btnApprove.Size = New-Object System.Drawing.Size(110, 32)
$btnApprove.Text = "APPROVE"
$btnApprove.DialogResult = [System.Windows.Forms.DialogResult]::Yes
# Do not set AcceptButton — avoid silent Enter auto-approve.

$form.Controls.Add($btnReject)
$form.Controls.Add($btnApprove)
$form.ActiveControl = $btnReject

$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
  Write-Output "APPROVE"
  exit 0
}
if ($result -eq [System.Windows.Forms.DialogResult]::Abort) {
  Write-Output "REJECT"
  exit 2
}
Write-Output "CLOSED"
exit 3
