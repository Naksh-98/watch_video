@echo off
echo ===================================================
echo     BATCH FOLDER COMPRESSOR (SyncCinema)
echo ===================================================
echo.

if "%~1"=="" (
    echo [ERROR] You didn't select a folder!
    echo Please drag and drop a FOLDER containing your movies onto this .bat file.
    pause
    exit /b
)

if not exist "%~1\" (
    echo [ERROR] This is not a folder. Please drag and drop a FOLDER.
    pause
    exit /b
)

echo Scanning folder: "%~1"
echo.

:: Loop through all MKV and MP4 files in the folder
for %%F in ("%~1\*.mkv" "%~1\*.mp4") do (
    echo ---------------------------------------------------
    echo Processing: "%%~nxF"
    
    :: Skip files that already have "_compressed_for_web" in their name
    echo "%%~nxF" | find /i "_compressed_for_web" >nul
    if errorlevel 1 (
        if exist "%%~dpnF.srt" (
            echo [SUBTITLE DETECTED] Found "%%~nF.srt"! Burning into video...
            pushd "%%~dpF"
            call "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe" -i "%%~nxF" -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast -crf 27 -maxrate 800k -bufsize 1600k -vf "scale=-2:720,subtitles='%%~nF.srt'" -c:a aac -b:a 128k -ac 2 "%%~dpnF_compressed_for_web.mp4"
            popd
        ) else (
            call "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe" -i "%%F" -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast -crf 27 -maxrate 800k -bufsize 1600k -vf "scale=-2:720" -c:a aac -b:a 128k -ac 2 "%%~dpnF_compressed_for_web.mp4"
        )
    ) else (
        echo Skipping already compressed file: "%%~nxF"
    )
)

echo.
echo ===================================================
echo ALL FILES DONE!
echo ===================================================
pause
