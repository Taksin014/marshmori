# Builds Marshmori from this folder and installs it, in one go.
# For developers: started by scripts\build-from-source.cmd (double-click it). Run it again
# to update. Everyone else installs from https://taksin014.github.io/marshmori/ instead.
#
#  1. checks that Node.js and Rust are there (and says where to get them if not)
#  2. npm install, then builds the app and its installer (npm run tauri build)
#  3. runs the installer without questions, then opens Marshmori
#
# Nothing here needs administrator rights: Marshmori installs for the current user.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Stop-With($text) {
  Say ""
  Say $text 'Red'
  Say ""
  Read-Host 'กด Enter เพื่อปิด'
  exit 1
}

Say ''
Say '  Marshmori — ติดตั้งจากซอร์สโค้ดในโฟลเดอร์นี้' 'Cyan'
Say ''

# 1. What has to be there first.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-With 'ยังไม่มี Node.js — ติดตั้งรุ่น LTS จาก https://nodejs.org แล้วเปิดไฟล์นี้ใหม่'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  $cargoHome = Join-Path $env:USERPROFILE '.cargo\bin'
  if (Test-Path (Join-Path $cargoHome 'cargo.exe')) {
    $env:Path = "$cargoHome;$env:Path"
  } else {
    Stop-With 'ยังไม่มี Rust — ติดตั้งจาก https://rustup.rs (เลือกค่าเริ่มต้น) และ Visual Studio Build Tools ("Desktop development with C++") แล้วเปิดไฟล์นี้ใหม่'
  }
}
Say ("  Node.js " + (node -v) + "  ·  " + (cargo -V)) 'DarkGray'

# 2. Build.
Say ''
Say '  [1/3] ติดตั้งแพ็กเกจของหน้าตาแอป (npm install)…' 'White'
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Stop-With 'npm install ไม่สำเร็จ ดูข้อความด้านบน' }

Say ''
Say '  [2/3] สร้างแอปและตัวติดตั้ง (ครั้งแรกนานราว 5–10 นาที)…' 'White'
npm run tauri build
if ($LASTEXITCODE -ne 0) { Stop-With 'สร้างแอปไม่สำเร็จ ดูข้อความด้านบน (ส่วนใหญ่คือยังไม่ได้ติดตั้ง Visual Studio Build Tools)' }

$setup = Get-ChildItem -Path (Join-Path $root 'target\release\bundle\nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $setup) { Stop-With 'ไม่พบไฟล์ตัวติดตั้งใน target\release\bundle\nsis' }

# 3. Install and open.
Say ''
Say ("  [3/3] ติดตั้ง " + $setup.Name + "…") 'White'
# Marshmori may be running (an update): close it so its files can be replaced.
Get-Process -Name 'marshmori' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $setup.FullName -ArgumentList '/P' -Wait

$exe = Join-Path $env:LOCALAPPDATA 'Marshmori\marshmori.exe'
if (Test-Path $exe) {
  Start-Process -FilePath $exe
  Say ''
  Say '  เรียบร้อย! Mamori อยู่ที่ขอบบนกลางจอแล้ว — หน้าต้อนรับจะพาเชื่อมต่อ agent ให้' 'Green'
} else {
  Say ''
  Say '  ติดตั้งเสร็จแล้ว เปิด Marshmori ได้จาก Start Menu' 'Green'
}
Say ''
Start-Sleep -Seconds 4
