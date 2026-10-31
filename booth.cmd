@echo off
rem Opens straight into the Confessional Booth - the recorder on its own, no editor window.
rem Same reason this is a .cmd and not a .ps1: see pepstudio.cmd.
call "%~dp0pepstudio.cmd" --booth %*
