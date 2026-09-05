@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions
title He thong tu van chung khoan - Deploy Docker

REM ============================================================
REM  Vo boc de goi deploy.sh tu cmd.exe.
REM
REM  cmd khong chay duoc file .sh. Neu dang o Git Bash thi cu
REM  dung "./deploy.sh" nhu binh thuong, khong can file nay.
REM
REM  Moi tham so deu duoc chuyen thang xuong deploy.sh:
REM    deploy.bat
REM    deploy.bat --no-cache
REM    deploy.bat --db-only
REM    deploy.bat --tag 1.2 --logs
REM    deploy.bat --help
REM
REM  Du lieu nen (buoc 7 cua deploy.sh, chay ngay sau alembic):
REM    deploy.bat                 nap backups\clone_symbols_accounts.sql
REM                               (symbols + tai khoan) roi chay app.scripts.seed
REM    deploy.bat --dump-clone    dump lai file .sql do tu MySQL may dev
REM                               (127.0.0.1:3306) roi thoat, khong deploy
REM    deploy.bat --skip-seed     bo qua ca hai buoc tren
REM
REM  Thieu buoc do thi alembic chi tao bang rong: bang staff khong co dong nao
REM  nen moi lan dang nhap deu tra ve 401.
REM ============================================================

REM  Goi thang bash.exe cua Git chu KHONG dung lenh "bash" tren PATH:
REM  trong cmd, "bash" thuong tro toi C:\Windows\System32\bash.exe cua WSL.
REM  Bash cua WSL chay trong Linux, thay o dia /mnt/d/... va noi toi mot
REM  docker khac - deploy se hong theo kieu rat kho doan.
set "GIT_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GIT_BASH%" set "GIT_BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not exist "%GIT_BASH%" set "GIT_BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"

if not exist "%GIT_BASH%" (
    echo.
    echo  [LOI] Khong tim thay Git Bash.
    echo        Cai Git for Windows: https://git-scm.com/download/win
    echo        Hoac mo Git Bash roi chay:  ./deploy.sh
    echo.
    pause
    exit /b 1
)

REM  Chuyen ve thu muc chua file .bat nay roi moi goi bash, de deploy.sh luon
REM  chay dung cho du ban dang dung o thu muc nao. Khong truyen duong dan
REM  Windows sang bash: MSYS se dich nguoc lai va lam hong tham so.
cd /d "%~dp0"

"%GIT_BASH%" deploy.sh %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo  [LOI] deploy.sh ket thuc voi ma loi %RC%.
    echo.
)

REM  Chay bang cach nhay doi chuot thi giu cua so lai de con doc log.
echo %CMDCMDLINE% | find /i "/c" >nul && pause

exit /b %RC%
