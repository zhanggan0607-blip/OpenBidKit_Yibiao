; 自定义 NSIS 脚本：移除「为所有用户 / 仅为我」安装模式选择页，固定按 per-user 安装
; electron-builder 在辅助安装器（oneClick=false）渲染安装模式页前会先执行 customInstallMode 宏，
; 这里把内建变量设为强制当前用户，页面函数随即 Abort 并直接按 per-user 模式继续。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
