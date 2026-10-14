# Stop the stack and remove all its data: the database (jobs, tasks, activity log) and the
# generated files in .\data. The next `docker compose up` starts empty.
# Usage: .\tools\clean.ps1
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")   # always run from the project folder

docker compose down -v                        # stop the containers and delete the database volume
New-Item -ItemType Directory -Force data | Out-Null
Get-ChildItem data -Force | Remove-Item -Recurse -Force   # delete the contents of .\data, keep the folder
Write-Host "Stopped. Database and generated files removed."
