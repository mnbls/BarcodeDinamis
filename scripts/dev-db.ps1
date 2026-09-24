<#
  Klaster PostgreSQL LOKAL khusus proyek ini, untuk pengembangan di Windows.
  Tidak menyentuh service PostgreSQL yang mungkin sudah terpasang di komputer Anda:
  data ada di folder .devdb dan berjalan di port 54329 (hanya localhost).

  Pemakaian (dari folder proyek):
    powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 init      # buat klaster + role + database (sekali)
    powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 start
    powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 stop
    powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 status
    powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 psql      # buka psql ke database dev
    powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 destroy   # hapus SEMUA data dev

  Opsional: $env:PGBIN (folder bin PostgreSQL), $env:DEVDB_PORT, $env:DEVDB_DIR.
  Kredensial di bawah hanya untuk klaster lokal ini (bukan rahasia produksi).
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'status', 'psql', 'destroy')]
  [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Base = if ($env:DEVDB_DIR) { $env:DEVDB_DIR } else { Join-Path $Root '.devdb' }
$Data = Join-Path $Base 'data'
$Log  = Join-Path $Base 'postgres.log'
$Port = if ($env:DEVDB_PORT) { [int]$env:DEVDB_PORT } else { 54329 }

$SuperPassword = 'devpass_local_only'
$AppRole       = 'barcode_app'
$AppPassword   = 'barcode_dev_pw'
$Databases     = @('barcode_dinamis', 'barcode_dinamis_test')

function Find-PgBin {
  if ($env:PGBIN -and (Test-Path (Join-Path $env:PGBIN 'pg_ctl.exe'))) { return $env:PGBIN }
  $found = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
    Sort-Object { [int]($_.Name -replace '\D.*$', '') } -Descending |
    ForEach-Object { Join-Path $_.FullName 'bin' } |
    Where-Object { Test-Path (Join-Path $_ 'pg_ctl.exe') } | Select-Object -First 1
  if (-not $found) { throw 'PostgreSQL tidak ditemukan. Pasang PostgreSQL atau isi $env:PGBIN dengan folder bin-nya.' }
  return $found
}

$Bin = Find-PgBin
$PgCtl = Join-Path $Bin 'pg_ctl.exe'

function Test-Running {
  if (-not (Test-Path (Join-Path $Data 'postmaster.pid'))) { return $false }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # native stderr must not become a terminating error
  try {
    & $PgCtl status -D $Data 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $previous }
}

function Invoke-Psql([string]$Database, [string]$Sql) {
  $env:PGPASSWORD = $SuperPassword
  & (Join-Path $Bin 'psql.exe') -h 127.0.0.1 -p $Port -U postgres -d $Database -X -q -v ON_ERROR_STOP=1 -c $Sql
  if ($LASTEXITCODE -ne 0) { throw "psql gagal: $Sql" }
}

function Start-Cluster {
  if (Test-Running) { Write-Host "Sudah berjalan di port $Port."; return }
  # Jangan pakai "-Wait" / "pg_ctl -w": keduanya menunggu proses turunan (server yang terus hidup) sehingga
  # skrip menggantung. Nyalakan lalu tunggu sampai server benar-benar menerima koneksi.
  Start-Process -FilePath $PgCtl -WindowStyle Hidden `
    -ArgumentList @('start', '-D', "`"$Data`"", '-l', "`"$Log`"", '-o', "`"-p $Port -c listen_addresses=127.0.0.1`"")
  $ready = Join-Path $Bin 'pg_isready.exe'
  $ok = $false
  for ($i = 0; $i -lt 120; $i++) {
    & $ready -h 127.0.0.1 -p $Port -q
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ok) { throw "Gagal menyalakan PostgreSQL dalam 60 detik. Lihat $Log" }
  Write-Host "PostgreSQL dev berjalan di 127.0.0.1:$Port"
}

switch ($Command) {
  'init' {
    if (Test-Path $Data) { throw "Klaster sudah ada di $Data (gunakan 'start')." }
    New-Item -ItemType Directory -Force $Base | Out-Null
    $pwFile = Join-Path $Base 'pwfile.tmp'
    [IO.File]::WriteAllText($pwFile, $SuperPassword)
    try {
      & (Join-Path $Bin 'initdb.exe') -D $Data -U postgres --auth=scram-sha-256 --pwfile=$pwFile -E UTF8 --locale-provider=icu --icu-locale=en-US --locale=C
      if ($LASTEXITCODE -ne 0) { throw 'initdb gagal' }
    } finally { Remove-Item $pwFile -Force -ErrorAction SilentlyContinue }

    Start-Cluster
    Invoke-Psql 'postgres' "CREATE ROLE $AppRole LOGIN PASSWORD '$AppPassword' CREATEDB;"
    foreach ($db in $Databases) {
      Invoke-Psql 'postgres' "CREATE DATABASE $db OWNER $AppRole ENCODING 'UTF8' TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C';"
    }
    Write-Host ''
    Write-Host 'Klaster siap. Isi .env dengan:'
    Write-Host "  DATABASE_URL=postgres://${AppRole}:${AppPassword}@127.0.0.1:${Port}/$($Databases[0])"
    Write-Host "  TEST_DATABASE_URL=postgres://${AppRole}:${AppPassword}@127.0.0.1:${Port}/$($Databases[1])"
    Write-Host 'Lalu: npm run migrate ; npm run seed ; npm run dev'
  }
  'start'   { Start-Cluster }
  'stop'    { if (Test-Running) { & $PgCtl stop -D $Data -m fast } else { Write-Host 'Tidak sedang berjalan.' } }
  'status'  { if (Test-Running) { Write-Host "Berjalan di 127.0.0.1:$Port (data: $Data)" } else { Write-Host 'Tidak berjalan.' } }
  'psql'    {
    $env:PGPASSWORD = $AppPassword
    & (Join-Path $Bin 'psql.exe') -h 127.0.0.1 -p $Port -U $AppRole -d $Databases[0]
  }
  'destroy' {
    if (Test-Running) { & $PgCtl stop -D $Data -m fast | Out-Null }
    if (Test-Path $Base) { Remove-Item $Base -Recurse -Force; Write-Host "Dihapus: $Base" }
  }
}
