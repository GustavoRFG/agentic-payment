# TRUSTFORGE B.3.5.2 — Windows masked secret dialog (production UI)
# No programmatic clipboard read. Human pastes into PasswordChar textbox.
# Args: -ExpectedWallet <0x…> only (public address). Never pass the private key via argv.
# Exit: 0 = success (raw credential bytes on stdout, no trailing newline)
#       2 = cancel, 3 = closed, 4 = internal invalid

param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedWallet
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Test-PrivateKeyFormat([string]$value) {
  if ($null -eq $value) { return $false }
  if ($value.Length -eq 64) {
    return ($value -match '^[0-9a-fA-F]{64}$')
  }
  if ($value.Length -eq 66) {
    return ($value -match '^0x[0-9a-fA-F]{64}$')
  }
  return $false
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "TRUSTFORGE - Buyer Private Key"
$form.Size = New-Object System.Drawing.Size(560, 280)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$labelTitle = New-Object System.Windows.Forms.Label
$labelTitle.Location = New-Object System.Drawing.Point(16, 16)
$labelTitle.Size = New-Object System.Drawing.Size(520, 20)
$labelTitle.Text = "TRUSTFORGE - Buyer Private Key"
$labelTitle.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)

$labelWallet = New-Object System.Windows.Forms.Label
$labelWallet.Location = New-Object System.Drawing.Point(16, 48)
$labelWallet.Size = New-Object System.Drawing.Size(520, 36)
$labelWallet.Text = "Expected wallet:`r`n$ExpectedWallet"

$labelHint = New-Object System.Windows.Forms.Label
$labelHint.Location = New-Object System.Drawing.Point(16, 92)
$labelHint.Size = New-Object System.Drawing.Size(520, 20)
$labelHint.Text = "Paste the MetaMask private key below."

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Location = New-Object System.Drawing.Point(16, 120)
$textBox.Size = New-Object System.Drawing.Size(520, 28)
$textBox.Font = New-Object System.Drawing.Font("Consolas", 11)
$textBox.UseSystemPasswordChar = $true
$textBox.MaxLength = 66

$labelMeta = New-Object System.Windows.Forms.Label
$labelMeta.Location = New-Object System.Drawing.Point(16, 156)
$labelMeta.Size = New-Object System.Drawing.Size(520, 20)
$labelMeta.Text = "Length: 0    Format: invalid"

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Location = New-Object System.Drawing.Point(320, 196)
$btnCancel.Size = New-Object System.Drawing.Size(100, 28)
$btnCancel.Text = "Cancel"
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$btnContinue = New-Object System.Windows.Forms.Button
$btnContinue.Location = New-Object System.Drawing.Point(436, 196)
$btnContinue.Size = New-Object System.Drawing.Size(100, 28)
$btnContinue.Text = "Continue"
$btnContinue.Enabled = $false
$btnContinue.DialogResult = [System.Windows.Forms.DialogResult]::OK

function Update-Meta {
  $v = $textBox.Text
  $len = $v.Length
  $ok = Test-PrivateKeyFormat $v
  $fmt = if ($ok) { "valid" } else { "invalid" }
  $labelMeta.Text = "Length: $len    Format: $fmt"
  $btnContinue.Enabled = $ok
}

$textBox.Add_TextChanged({ Update-Meta })

$form.Controls.Add($labelTitle)
$form.Controls.Add($labelWallet)
$form.Controls.Add($labelHint)
$form.Controls.Add($textBox)
$form.Controls.Add($labelMeta)
$form.Controls.Add($btnCancel)
$form.Controls.Add($btnContinue)
$form.AcceptButton = $btnContinue
$form.CancelButton = $btnCancel

$result = $form.ShowDialog()
$value = $textBox.Text
$textBox.Text = ""
$form.Dispose()

if ($result -eq [System.Windows.Forms.DialogResult]::Cancel) {
  exit 2
}
if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
  exit 3
}
if (-not (Test-PrivateKeyFormat $value)) {
  exit 4
}

$bytes = [System.Text.Encoding]::ASCII.GetBytes($value)
$value = $null
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = 0 }
exit 0
