@echo off
cd /d "%~dp0"
npx ts-node --compiler-options "{\"module\":\"CommonJS\"}" %*
