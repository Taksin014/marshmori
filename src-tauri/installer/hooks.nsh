; Marshmori's own steps in the installer (tauri.conf.json → bundle.windows.nsis.installerHooks).
;
; Uninstalling takes out everything Marshmori put outside its own folder: its hooks in
; Claude Code / Codex / Antigravity (their configs are backed up first, as always), the
; "สั่งงาน Mamori ที่นี่" entry in Explorer's folder menu, and start-up. An update runs
; the old uninstaller with /UPDATE: then nothing is touched, so the agents stay connected.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-cleanup'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; "Delete the application data" ticked: Marshmori's settings, tasks and logs go too.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\Marshmori"
    RmDir /r "$LOCALAPPDATA\Marshmori"
  ${EndIf}
!macroend
