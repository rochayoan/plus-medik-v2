# G7 · Configura la clave de OpenAI en un archivo .env LOCAL, de forma segura. LO EJECUTA USTED (PowerShell, en la carpeta del proyecto):
#     powershell -ExecutionPolicy Bypass -File scripts\g7\setup-openai-key.ps1
#
# Qué hace:
#   1. Se niega a continuar si .env NO está ignorado por git (así la clave no puede subirse al repositorio por error).
#   2. Pide la clave SIN mostrarla en pantalla (no queda en el historial de PowerShell ni en la salida).
#   3. Escribe SOLO la línea OPENAI_API_KEY=... en .env (conserva otras líneas que ya tuviera) y deja el archivo legible únicamente por su usuario de Windows.
#   4. Nunca imprime la clave: solo confirma cuántos caracteres tiene.
# Después, la verificación del modelo usa ese archivo: npx tsx --env-file=.env scripts/g7/agent-live-eval.ts ...  (ver docs/g7/16).
# Para borrarla cuando termine: Remove-Item .env   (y revoque o rote la clave en el panel de OpenAI si la usó en un equipo compartido).

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

git check-ignore -q .env
if ($LASTEXITCODE -ne 0) {
  Write-Host "ABORTADO: .env NO está ignorado por git. Agregue la línea '.env' a .gitignore y vuelva a ejecutar." -ForegroundColor Red
  exit 1
}

$secure = Read-Host "Pegue su clave de OpenAI (no se mostrará)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$plain = $plain.Trim()
if ($plain -notmatch '^sk-[A-Za-z0-9_\-]{20,}$') {
  Write-Host "La clave no tiene el formato esperado (debe empezar por sk- y no tener espacios). No se guardó nada." -ForegroundColor Red
  exit 1
}

$lines = @()
if (Test-Path .env) { $lines = @(Get-Content .env -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*OPENAI_API_KEY\s*=' }) }
$lines += "OPENAI_API_KEY=$plain"
[IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), $lines, (New-Object Text.UTF8Encoding($false)))
$plain = $null

# Solo su usuario puede leer o escribir el archivo.
icacls .env /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null

Write-Host "Clave guardada en .env ($($lines[-1].Length - 15) caracteres; no se muestra). El archivo está ignorado por git y restringido a su usuario." -ForegroundColor Green
Write-Host "Siguiente paso:  npx tsx --env-file=.env scripts/g7/agent-live-eval.ts --check-models gpt-6.1-sol"
