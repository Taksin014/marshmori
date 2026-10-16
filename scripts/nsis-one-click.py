# Builds src-tauri/installer/installer.nsi from Tauri's own NSIS template, adding
# Marshmori's one-click install. Every change is marked "; Marshmori:".
#
# After upgrading the Tauri CLI (package.json @tauri-apps/cli), take the template of that
# version and run this again (PowerShell):
#   $v = "tauri-cli-v2.12.1"   # the CLI's version
#   gh api "repos/tauri-apps/tauri/contents/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi?ref=$v" --jq .content |
#     python -c "import sys,base64;sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))" > upstream.nsi
#   python scripts/nsis-one-click.py upstream.nsi src-tauri/installer/installer.nsi
# An edit that no longer matches stops with an AssertionError: look at what changed upstream.
# Also update the version named in the header below.
import sys

src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()


def edit(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:70], s.count(old))
    s = s.replace(old, new)


header = """; Marshmori's installer: Tauri's own NSIS template (tauri-cli v2.12.1,
; crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) that installs on opening.
; Opened by double-click it asks nothing: a progress bar runs (installing over an older or
; the same version, as an update does: the agents' hooks and the settings stay as they
; are), Marshmori is closed if it is open, the Start Menu and desktop shortcuts are made,
; and Marshmori opens when done. The "ติดตั้ง Marshmori" button on the download page was
; the go-ahead. Only installing an older version over a newer one still asks. Passive (/P),
; silent (/S) and update (/UPDATE) runs behave exactly as in Tauri's template. Everything
; changed is marked "; Marshmori:" — when the Tauri CLI is upgraded, take its new template
; and apply these again.

"""
s = header + s

edit("""Var WixMode
""", """Var WixMode
; Marshmori: a plain double-click (not /P, /S or /UPDATE) installs right away.
Var OneClick
""")

edit("""; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
""", """; 1. Welcome Page
; Marshmori: none when opened by double-click: it goes straight to installing.
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassiveOrOneClick
!insertmacro MUI_PAGE_WELCOME

; Marshmori: the pages a double-click install doesn't show.
Function SkipIfPassiveOrOneClick
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  ${IfThen} $OneClick = 1 ${|} Abort ${|}
FunctionEnd
""")

edit("""  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
""", """  ${Else}
    Abort
  ${EndIf}

  ; Marshmori: one click installs over the same or an older version without uninstalling it
  ; first, as an update does, so the agents' hooks (Codex would ask to Trust them again) and
  ; the settings stay as they are. Only a downgrade, or a WiX install, still asks.
  ${If} $OneClick = 1
  ${AndIf} $WixMode = 0
  ${AndIf} $R0 >= 0
    Abort
  ${EndIf}

  ; Skip showing the page if passive
""")

edit("""; 5. Choose install directory page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
""", """; 5. Choose install directory page
; Marshmori: one click installs where it was before, or in the default folder.
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassiveOrOneClick
""")

edit("""!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH
""", """!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
; Marshmori: no finish page in a one-click install: Marshmori opening is the sign it's done.
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassiveOrOneClick
!insertmacro MUI_PAGE_FINISH
""")

edit("""  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
""", """  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; Marshmori: a plain double-click is the one-click install.
  ${If} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIfNot} ${Silent}
    StrCpy $OneClick 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
""")

# Install section: close a running Marshmori without asking (the button was the OK).
edit("""Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
""", """Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  ; Marshmori: in a one-click install pressing the button was the OK, so an open Marshmori
  ; is closed without another question (as in a passive install), and opened again at the end.
  ${IfThen} $OneClick = 1 ${|} StrCpy $PassiveMode 1 ${|}
  !insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${IfThen} $OneClick = 1 ${|} StrCpy $PassiveMode 0 ${|}
""")

edit("""  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
""", """  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ; Marshmori: and for a one-click install, which has no finish page either.
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
  ${OrIf} $OneClick = 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
""")

edit("""  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd
""", """  ; Auto close this page for passive mode
  ; Marshmori: and for a one-click install.
  ${If} $PassiveMode = 1
  ${OrIf} $OneClick = 1
    SetAutoClose true
  ${EndIf}
SectionEnd
""")

edit("""Function .onInstSuccess
""", """Function .onInstSuccess
  ; Marshmori: a one-click install ends with Marshmori opening.
  ${If} $OneClick = 1
    Call RunMainBinary
  ${EndIf}

""")

open(dst, "w", encoding="utf-8", newline="\n").write(s)
print("written", dst, len(s.splitlines()), "lines")
