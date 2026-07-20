# spec/independence/06 §2's hub-side PRE-CUTOVER mirror -- runs the SAME
# wixy_server.backup module deploy/standalone/'s `backup` compose service
# runs on the droplet, unmodified, just pointed at the FLEET's OWN Storage
# tree instead ("an equivalent scheduled hub job mirrors fleet Storage the
# same way -- her backup custody starts BEFORE her hosting does"). A ONE-SHOT
# invocation (WIXY_BACKUP_RUN_ONCE=1) -- the nightly cadence is the calling
# Scheduled Task's job, not this script's; see README.md in this directory
# for what registers the task and why this script does NOT do that itself.
param(
    [string]$StorageRoot = "D:\Servers\Wixy\Storage",
    [string]$StateBackupRepo = $env:WIXY_STATE_BACKUP_REPO,
    [string]$DeployKeyPath = "$env:USERPROFILE\.ssh\wixy-hub-state-backup",
    [string]$StatusPath = "C:\Admin\wixy-hub-backup-status.json",
    [string]$PythonExe = "$env:LOCALAPPDATA\Python\pythoncore-3.14-64\python.exe"
)

# Pinned per the fleet's own UTF-8 doctrine (a Scheduled Task's
# non-interactive console defaults to the system code page, which would
# mojibake this backup's own git/commit-message output).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $StateBackupRepo) {
    Write-Error "WIXY_STATE_BACKUP_REPO must be set (env var or -StateBackupRepo) -- the <org>/ca-state-backup SSH URL. See README.md in this directory."
    exit 1
}
if (-not (Test-Path $DeployKeyPath)) {
    Write-Error "No deploy key found at $DeployKeyPath -- generate one write-scoped to ca-state-backup ONLY (README.md, Prerequisites)."
    exit 1
}

$env:WIXY_STORAGE_ROOT = $StorageRoot
$env:WIXY_STATE_BACKUP_REPO = $StateBackupRepo
$env:WIXY_BACKUP_RUN_ONCE = "1"
$env:WIXY_BACKUP_STATUS_PATH = $StatusPath
# Same IdentitiesOnly reasoning as docker-compose.yml's own GIT_SSH_COMMAND
# entries -- never fall back to trying every other key/agent identity first.
$env:GIT_SSH_COMMAND = "ssh -i `"$DeployKeyPath`" -o IdentitiesOnly=yes"

& $PythonExe -m wixy_server.backup
exit $LASTEXITCODE
