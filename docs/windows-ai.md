# Windows AI and automatic endpoint selection

My Kitchen runs on the app server PC. The dual-boot PC runs llama.cpp under
Ubuntu or Windows. Configure both private addresses once on the app server;
the app selects an available installation for each AI call. The AI PC must be
awake, connected, and running its model.

## Install the Windows runtime and model

Use an official [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases),
and verify the downloaded archive against its published SHA-256 digest. Extract
the whole archive, including its DLLs. Choose the Windows x64 Vulkan build for
supported AMD, Intel, or NVIDIA GPUs; a CUDA build is another option for NVIDIA.
Use a CPU build if no supported GPU is available. The installed GPU driver must
support the chosen backend.

Keep the runtime and launcher outside the repository in a durable directory
visible to both the interactive user and Task Scheduler, such as
`D:\tools\MyKitchenAI`. App-sandbox versions of `LOCALAPPDATA` can be invisible
to the scheduled task. Use the same GGUF model, quantization, context size,
and API alias as Ubuntu. A model stored only on the Ubuntu filesystem
must first be copied to storage Windows can read; do not download an unrelated
model as a substitute. Include every shard if the model is split into files.

Check the selected backend's device names before choosing one:

```powershell
& 'D:\tools\MyKitchenAI\bin\llama-server.exe' --list-devices
```

The launcher's default is `Vulkan1`. Set `-Device Vulkan0`, `-Device CUDA0`, or
another name from that command as appropriate. `-Device none` uses the CPU.
The launcher sets one parallel generation slot and an 8192-token context by
default. Increase `-ContextSize` only within the model and hardware limits.
The available context must accommodate the app's prompts and generated output.

## Private address and firewall

Use a stable LAN IPv4 address or a Tailscale address. A Tailscale installation
in Windows has a separate device identity and address from the Ubuntu
installation on the same PC. On a LAN, a router reservation may give both OSes
the same address; in that case a single URL can suffice.

The launcher requires an exact loopback, RFC 1918, or Tailscale IPv4 address.
It waits up to 120 seconds for that address to appear at logon. Loopback is
useful for testing but cannot be reached from the separate app server. Use the
Windows PC's private address for normal operation. Avoid broad bindings such
as `0.0.0.0`, router port forwarding, or a public tunnel to llama.cpp.

If Windows Firewall blocks the app server, add an inbound rule in an elevated
PowerShell window, restricted to the actual app server source address. These
addresses are examples; replace both before running:

```powershell
$serverPath = 'D:\tools\MyKitchenAI\bin\llama-server.exe'
New-NetFirewallRule -DisplayName 'My Kitchen AI from app server' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 `
    -Program $serverPath -LocalAddress '100.100.10.2' `
    -RemoteAddress '100.100.10.10' -Profile Any
```

For Tailscale, restrict tailnet access to the app server as well. The launcher
does not enable API authentication; access is controlled by the private network
and firewall. If API keys are required, configure both servers consistently
using llama.cpp's supported key-file mechanism and set the same `LLM_API_KEY`
on the app server. Do not store keys in the repository or task arguments.

## Launch and start automatically at sign-in

Copy the checked-in launcher to the installation folder. In this example,
adjust the runtime/model paths and private address to the Windows installation:

```powershell
$aiRoot = 'D:\tools\MyKitchenAI'
New-Item -ItemType Directory -Path $aiRoot -Force > $null
$launcherPath = Join-Path $aiRoot 'start-windows-ai.ps1'
Copy-Item -LiteralPath '.\scripts\start-windows-ai.ps1' -Destination $launcherPath
$serverPath = Join-Path $aiRoot 'bin\llama-server.exe'
$modelPath = Join-Path $aiRoot 'models\model.gguf'
$listenAddress = '100.100.10.2'
$modelAlias = 'assistant'

& $launcherPath -ServerPath $serverPath -ModelPath $modelPath `
    -ListenAddress $listenAddress -ModelAlias $modelAlias -Device Vulkan1
```

The foreground command stays running. Stop it before registering and starting
the task below. Use the same single alias as Ubuntu, matching My Kitchen's
`LLM_MODEL` exactly. For example, use `qwen2.5:7b` if that is the configured
model name. With a comma-separated alias list, this runtime advertises only
the first alias in `/v1/models`; put the configured model first, such as
`qwen2.5:7b,assistant`. Both endpoints must advertise the exact `LLM_MODEL`
for the app's readiness check to succeed.

Create a task for the current user, using the same variables from above. It
starts a hidden PowerShell process after that user signs in, restarts failures
after one minute, and has no execution time limit. It does not need to store a
password or run with administrator privileges:

```powershell
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ServerPath "{1}" -ModelPath "{2}" -ListenAddress "{3}" -ModelAlias "{4}" -Device Vulkan1' -f `
    $launcherPath, $serverPath, $modelPath, $listenAddress, $modelAlias
$taskAction = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument $taskArguments
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser `
    -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'My Kitchen AI' -Action $taskAction `
    -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force
Start-ScheduledTask -TaskName 'My Kitchen AI'
```

Keep the same device/context choices in the task arguments and manual command.
This starts at sign-in, not before sign-in. The launcher prevents concurrent
copies in the same session and refuses an occupied port without stopping any
existing program. `--log-disable` and discarded native output prevent prompts
and answers from being saved in logs. Check Task Scheduler's `LastTaskResult`
for a failed startup; `267009` (`0x41301`) means the task is still running.

## Configure both URLs on the app server

Set these through the app server's deployment environment or hosting settings.
Both production Compose entry files pass them through to the app. Do not
hand-edit repository `.env*` files. For a shell-managed Compose deployment, the
following exports apply to this deployment command; keep equivalent settings
in the server's private deployment configuration for future recreations:

```sh
export LLM_BASE_URL='http://100.100.10.1:8080/v1'
export LLM_FALLBACK_BASE_URL='http://100.100.10.2:8080/v1'
export LLM_MODEL='assistant'
docker compose up -d --build app
```

Use `docker compose -f compose.cloud-db.yaml up -d --build app` instead if that
is the existing deployment. These example URLs represent Ubuntu and Windows,
respectively. They must be reachable from the app container, not just the web
browser. Keep any existing `LLM_API_KEY` configuration; the same key and model
are used for both URLs. When the local servers do not require a key, the app's
default placeholder is sufficient. Changing the environment requires recreating
the app container; a plain `docker compose restart` does not apply new values.

With two distinct URLs and no recent choice, My Kitchen checks both authenticated
`/v1/models` responses concurrently with a two-second probe deadline. It chooses
an endpoint advertising the configured model and remembers a successful choice
for 30 seconds. Within that period, each request checks the preferred endpoint
first and checks the other if the preferred endpoint is unavailable. After the
period expires, both are checked again. A transient connection or server failure
before any response chunk can try the other available endpoint once. A started
answer is never combined with output from a second model. Authentication or
configuration errors still surface as an assistant error. If neither installation
is available, ordinary recipe, pantry, and grocery features continue working.

## Verify each boot scenario

From the app server, check readiness and then try a short assistant request.
The [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
returns HTTP 200 from `/health` when the model is ready and 503 while loading:

```sh
curl --fail --max-time 3 http://100.100.10.2:8080/health
curl --fail --max-time 3 http://100.100.10.2:8080/v1/models
```

Add an authorization header securely if API keys are configured; `/health`
itself is public. Then check:

1. Windows is running and Ubuntu is offline: chat and a recipe AI operation work.
2. After rebooting into Ubuntu, the same operations work with no app configuration change.
3. With both AI servers stopped, the app reports the assistant unavailable.
4. After starting the model again, the next request recovers automatically.

If startup fails, confirm the model file, device name, free RAM/VRAM, private
adapter address, and available port. If local `/health` works but the app server
cannot reach it, check the firewall, tailnet policy, and routing from the app
container. If `/v1/models` lacks `LLM_MODEL`, fix the alias on that installation.
