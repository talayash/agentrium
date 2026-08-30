; NSIS hooks for the Agentrium installer.
;
; Wired via `bundle.windows.nsis.installerHooks` in tauri.conf.json.

!macro NSIS_HOOK_POSTINSTALL
  ; After an in-place update the .exe has a new icon, but Explorer keeps
  ; the previous one in %LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db,
  ; so the taskbar / Start Menu / desktop shortcuts still show the old logo.
  ; Refresh the shell so the new icon is picked up without a reboot.
  ExecWait '"$SYSDIR\ie4uinit.exe" -show' $0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
