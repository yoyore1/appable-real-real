# Snapshot the current golden template as v1 (run from repo root while on v1 code).
# Usage: .\scripts\snapshot-golden-v1.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "Building appable/expo-template:v1 from infra/expo-template ..."
docker build -t appable/expo-template:v1 -f infra/expo-template/Dockerfile infra/expo-template
docker tag appable/expo-template:v1 appable/expo-template:v1-launch
Write-Host "Done. Tags: appable/expo-template:v1, appable/expo-template:v1-launch"
Write-Host "Set GOLDEN_IMAGE=appable/expo-template:v1 in .env to pin new projects to v1."
