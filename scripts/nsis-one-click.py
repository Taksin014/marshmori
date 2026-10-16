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
; crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) with a one-click install.
; Opened by double-click it shows one page with one button, "ติดตั้ง"; pressing it installs
; (over an older or the same version, as an update does: the agents' hooks and the settings
; stay as they are), closes Marshmori if it is open, makes the Start Menu and desktop
; shortcuts, and opens Marshmori when done. Passive (/P), silent (/S) and update (/UPDATE)
; runs behave exactly as in Tauri's template. Everything changed is marked "; Marshmori:" —
; when the Tauri CLI is upgraded, take its new template and apply these again.

"""
s = header + s

edit("""Var WixMode
""", """Var WixMode
; Marshmori: a plain double-click (not /P, /S or /UPDATE) is the one-click install.
Var OneClick
Var WelcomeTitle
Var WelcomeNote
""")

edit("""; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
""", """; 1. Welcome Page
; Marshmori: the one page of the one-click install, its button reads "ติดตั้ง".
!define MUI_WELCOMEPAGE_TITLE "$WelcomeTitle"
!define MUI_WELCOMEPAGE_TEXT "$WelcomeNote"
!define MUI_PAGE_CUSTOMFUNCTION_PRE OneClickWelcomePre
!define MUI_PAGE_CUSTOMFUNCTION_SHOW OneClickWelcomeShow
!insertmacro MUI_PAGE_WELCOME

; Marshmori: what the page says, for a first install or an update.
Function OneClickWelcomePre
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $0 == ""
    StrCpy $WelcomeTitle "$(oneClickTitle)"
    StrCpy $WelcomeNote "$(oneClickText)"
  ${Else}
    nsis_tauri_utils::SemverCompare "${VERSION}" $0
    Pop $1
    ${If} $1 = 0
      StrCpy $WelcomeTitle "$(oneClickAgainTitle)"
      StrCpy $WelcomeNote "$(oneClickAgainText)"
    ${ElseIf} $1 = -1
      StrCpy $WelcomeTitle "$(oneClickTitle)"
      StrCpy $WelcomeNote "$(oneClickOlderText)"
    ${Else}
      StrCpy $WelcomeTitle "$(oneClickUpdateTitle)"
      StrCpy $WelcomeNote "$(oneClickUpdateText)"
    ${EndIf}
  ${EndIf}
FunctionEnd

; Marshmori: the button that moves on is the whole install.
Function OneClickWelcomeShow
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(oneClickButton)"
FunctionEnd

; Marshmori: the pages after the button are skipped in a one-click install.
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

edit("""{{#each language_files}}
  !include "{{this}}"
{{/each}}
""", """{{#each language_files}}
  !include "{{this}}"
{{/each}}

; Marshmori: the one-click page's words.
!ifdef LANG_THAI
  LangString oneClickTitle ${LANG_THAI} "ติดตั้ง ${PRODUCTNAME}"
  LangString oneClickText ${LANG_THAI} "Mamori มาร์ชแมลโลว์ตัวน้อยที่อยู่ขอบบนจอ คอยดู Claude Code, Codex และ Antigravity ให้คุณ$\\r$\\n$\\r$\\nกด ติดตั้ง แล้วรอสักครู่ เสร็จแล้ว ${PRODUCTNAME} จะเปิดขึ้นมาเอง$\\r$\\n$\\r$\\nติดตั้งให้ผู้ใช้คนนี้ ไม่ต้องใช้สิทธิ์ผู้ดูแลเครื่อง พร้อมไอคอนบนเดสก์ท็อปและใน Start Menu"
  LangString oneClickUpdateTitle ${LANG_THAI} "อัปเดต ${PRODUCTNAME}"
  LangString oneClickUpdateText ${LANG_THAI} "ในเครื่องมี ${PRODUCTNAME} $0 อยู่แล้ว$\\r$\\n$\\r$\\nกด ติดตั้ง เพื่ออัปเดตเป็น ${VERSION} การตั้งค่าและการเชื่อมต่อ agent อยู่ครบ ไม่ต้องตั้งใหม่$\\r$\\n$\\r$\\nถ้า ${PRODUCTNAME} เปิดอยู่ จะปิดให้ระหว่างติดตั้ง แล้วเปิดขึ้นมาใหม่เมื่อเสร็จ"
  LangString oneClickAgainTitle ${LANG_THAI} "ติดตั้ง ${PRODUCTNAME} ซ้ำ"
  LangString oneClickAgainText ${LANG_THAI} "ในเครื่องมี ${PRODUCTNAME} ${VERSION} เวอร์ชันนี้อยู่แล้ว$\\r$\\n$\\r$\\nกด ติดตั้ง เพื่อติดตั้งทับอีกครั้ง (เช่น ถ้าไฟล์ของโปรแกรมเสีย) การตั้งค่าและการเชื่อมต่อ agent อยู่ครบ$\\r$\\n$\\r$\\nถ้า ${PRODUCTNAME} เปิดอยู่ จะปิดให้ระหว่างติดตั้ง แล้วเปิดขึ้นมาใหม่เมื่อเสร็จ"
  LangString oneClickOlderText ${LANG_THAI} "ในเครื่องมี ${PRODUCTNAME} $0 ซึ่งใหม่กว่าตัวติดตั้งนี้ (${VERSION})$\\r$\\n$\\r$\\nกด ติดตั้ง แล้วจะถามก่อนว่าจะทำยังไงกับเวอร์ชันที่ใหม่กว่า"
  LangString oneClickButton ${LANG_THAI} "ติดตั้ง"
!endif
!ifdef LANG_ENGLISH
  LangString oneClickTitle ${LANG_ENGLISH} "Install ${PRODUCTNAME}"
  LangString oneClickText ${LANG_ENGLISH} "Mamori, a little marshmallow at the top of your screen, keeps an eye on Claude Code, Codex and Antigravity for you.$\\r$\\n$\\r$\\nPress Install and wait a moment. ${PRODUCTNAME} opens by itself when it's done.$\\r$\\n$\\r$\\nInstalled for this user, no administrator rights needed, with shortcuts on the desktop and in the Start Menu."
  LangString oneClickUpdateTitle ${LANG_ENGLISH} "Update ${PRODUCTNAME}"
  LangString oneClickUpdateText ${LANG_ENGLISH} "${PRODUCTNAME} $0 is already installed.$\\r$\\n$\\r$\\nPress Install to update to ${VERSION}. Your settings and agent connections stay as they are.$\\r$\\n$\\r$\\nIf ${PRODUCTNAME} is open, it is closed while installing and opened again when done."
  LangString oneClickAgainTitle ${LANG_ENGLISH} "Reinstall ${PRODUCTNAME}"
  LangString oneClickAgainText ${LANG_ENGLISH} "${PRODUCTNAME} ${VERSION}, this very version, is already installed.$\\r$\\n$\\r$\\nPress Install to install it again over itself (for example if its files are damaged). Your settings and agent connections stay as they are.$\\r$\\n$\\r$\\nIf ${PRODUCTNAME} is open, it is closed while installing and opened again when done."
  LangString oneClickOlderText ${LANG_ENGLISH} "${PRODUCTNAME} $0 is installed, which is newer than this installer (${VERSION}).$\\r$\\n$\\r$\\nPress Install and you will be asked what to do with the newer version first."
  LangString oneClickButton ${LANG_ENGLISH} "Install"
!endif
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
