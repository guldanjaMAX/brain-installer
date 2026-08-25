[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("protect", "unprotect")]
  [string]$Operation,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65536)]
  [int]$ExpectedLength
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

[byte[]]$inputBytes = $null
[byte[]]$outputBytes = $null
try {
  $inputStream = [Console]::OpenStandardInput()
  $inputBytes = New-Object byte[] $ExpectedLength
  $offset = 0
  while ($offset -lt $ExpectedLength) {
    $read = $inputStream.Read($inputBytes, $offset, $ExpectedLength - $offset)
    if ($read -le 0) { throw "DPAPI input ended before the declared length" }
    $offset += $read
  }

  if ($Operation -eq "protect") {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Protect(
      $inputBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  } else {
    $outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $inputBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
  }

  if ($null -eq $outputBytes -or $outputBytes.Length -lt 1) {
    throw "DPAPI returned no output"
  }
  $output = [Console]::OpenStandardOutput()
  $output.Write($outputBytes, 0, $outputBytes.Length)
  $output.Flush()
} finally {
  if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
  if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
}
