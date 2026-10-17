@echo off
echo ===================================================
echo     MOVIE COMPRESSOR FOR SLOW INTERNET (SyncCinema)
echo ===================================================
echo.
echo Converting and compressing: "%~nx1"
echo.

if "%~1"=="" (
    echo [ERROR] You didn't select a file!
    echo Please drag and drop a .mkv or .mp4 file directly onto this .bat file.
    pause
    exit /b
)

:: Set the output filename
set "OUTPUT_FILE=%~dpn1_compressed_for_web.mp4"

:: The Magic FFmpeg Command:
:: -c:v libx264 -profile:v high: Best H.264 quality profile for web
:: -preset veryfast: Super fast compression speed
:: -crf 27 -maxrate 800k -bufsize 1600k: Forces the final size to be tiny (under ~800MB) without exploding into pixels
:: -vf scale=-2:720: Downscales to 720p
:: -c:a aac -b:a 128k -ac 2: Crystal clear stereo audio (no foggy sounds)

if exist "%~dpn1.srt" (
    echo [SUBTITLES DETECTED] Found matching "%~n1.srt"!
    echo Burning subtitles directly into the video permanently...
    pushd "%~dp1"
    call "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe" -i "%~nx1" -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast -crf 27 -maxrate 800k -bufsize 1600k -vf "scale=-2:720,subtitles='%~n1.srt'" -c:a aac -b:a 128k -ac 2 "%OUTPUT_FILE%"
    popd
) else (
    call "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe" -i "%~1" -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryfast -crf 27 -maxrate 800k -bufsize 1600k -vf "scale=-2:720" -c:a aac -b:a 128k -ac 2 "%OUTPUT_FILE%"
)

echo.
echo ===================================================
echo DONE! 
echo Your compressed movie is saved as: 
echo "%OUTPUT_FILE%"
echo ===================================================
pause
