import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const BRIDGE_MAGIC = 0x52424a50;
const FRAME_TYPE_JSON_REQUEST = 1;
const FRAME_TYPE_JSON_RESPONSE = 2;
const FRAME_TYPE_LOG = 4;
const READ_ONLY_BRIDGE_METHODS = new Set([
    "bridge.handshake",
    "bridge.capabilities",
    "bridge.runtime_info",
    "bridge.ping",
    "bridge.poll_events",
    "ft.capabilities",
]);
const READ_ONLY_NET_PREFIXES = [
    "net.is_",
    "net.get_",
    "net.build_",
    "net.query_",
    "net.check_",
];
const FULU_PRINT_RPC_METHODS = new Set([
    "net.start_print",
    "net.start_local_print_with_record",
    "net.start_local_print",
    "net.start_send_gcode_to_sdcard",
    "net.start_sdcard_print",
]);
export function isFuluPrintRpcMethod(method) {
    return FULU_PRINT_RPC_METHODS.has(method.trim());
}
function normalizePlatform(value) {
    const normalized = (value || process.platform).trim().toLowerCase();
    if (normalized === "mac" || normalized === "macos" || normalized === "darwin") {
        return "darwin";
    }
    if (normalized === "windows" || normalized === "win" || normalized === "win32") {
        return "win32";
    }
    if (normalized === "linux") {
        return "linux";
    }
    throw new Error(`Unsupported platform "${value}". Valid platforms: darwin, win32, linux.`);
}
function existingPath(candidates) {
    return candidates.find((candidate) => fs.existsSync(candidate));
}
function quoteShell(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function quotePowerShell(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function resolveSlicerPath(explicitPath, platform) {
    if (explicitPath?.trim()) {
        return explicitPath.trim();
    }
    if (process.env.SLICER_PATH?.trim()) {
        return process.env.SLICER_PATH.trim();
    }
    if (process.env.FULU_ORCA_PATH?.trim()) {
        return process.env.FULU_ORCA_PATH.trim();
    }
    if (process.env.ORCASLICER_BAMBULAB_PATH?.trim()) {
        return process.env.ORCASLICER_BAMBULAB_PATH.trim();
    }
    if (platform === "darwin") {
        return (existingPath([
            "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
            "/Applications/Orca Studio.app/Contents/MacOS/OrcaSlicer",
            "/Applications/OrcaStudio.app/Contents/MacOS/OrcaStudio",
        ]) || "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer");
    }
    if (platform === "win32") {
        return "C:\\Program Files\\OrcaSlicer\\OrcaSlicer.exe";
    }
    return existingPath(["/usr/local/bin/orcaslicer", "/usr/bin/orcaslicer"]) || "orcaslicer";
}
function derivePluginDir(explicitPluginDir, slicerPath, platform) {
    if (explicitPluginDir?.trim()) {
        return explicitPluginDir.trim();
    }
    if (process.env.FULU_ORCA_PLUGIN_DIR?.trim()) {
        return process.env.FULU_ORCA_PLUGIN_DIR.trim();
    }
    if (process.env.ORCASLICER_BAMBULAB_PLUGIN_DIR?.trim()) {
        return process.env.ORCASLICER_BAMBULAB_PLUGIN_DIR.trim();
    }
    if (platform === "darwin") {
        const marker = ".app/Contents/MacOS/";
        const index = slicerPath.indexOf(marker);
        if (index >= 0) {
            return slicerPath.slice(0, index + marker.length - 1);
        }
    }
    const dirname = path.dirname(slicerPath);
    return dirname === "." ? "" : dirname;
}
function defaultRuntimeDir(platform, explicitRuntimeDir) {
    if (explicitRuntimeDir?.trim()) {
        return explicitRuntimeDir.trim();
    }
    if (platform === "darwin") {
        return (process.env.PJARCZAK_MAC_RUNTIME_DIR ||
            path.join(os.homedir(), "Library", "Application Support", "OrcaSlicer", "macos-bridge", "runtime"));
    }
    return undefined;
}
function checkFiles(baseDir, names, required = true, scope) {
    return names.map((name) => {
        const filePath = path.join(baseDir, name);
        return {
            name: scope ? `${scope}/${name}` : name,
            path: filePath,
            exists: fs.existsSync(filePath),
            required,
        };
    });
}
function platformFileChecks(platform, pluginDir, runtimeDir) {
    if (!pluginDir) {
        return [];
    }
    if (platform === "darwin") {
        const pluginChecks = checkFiles(pluginDir, [
            "install_runtime_macos.sh",
            "verify_runtime_macos.sh",
            "pjarczak_lima_instance.txt",
            "pjarczak-bambu-linux-host-wrapper",
            "pjarczak_bambu_linux_host",
            "pjarczak_bambu_linux_host_abi1",
            "pjarczak_bambu_linux_host_abi0",
            "libpjarczak_bambu_networking_bridge.dylib",
            "ca-certificates.crt",
            "slicer_base64.cer",
        ], true, "plugin");
        const linuxPluginChecks = checkFiles(pluginDir, [
            "libbambu_networking.so",
            "libBambuSource.so",
        ], false, "linux-plugin");
        const runtimeChecks = runtimeDir
            ? checkFiles(runtimeDir, [
                "pjarczak_bambu_linux_host",
                "pjarczak_bambu_linux_host_abi1",
                "pjarczak_bambu_linux_host_abi0",
                "ca-certificates.crt",
                "slicer_base64.cer",
            ], true, "runtime").concat(checkFiles(runtimeDir, [
                "libbambu_networking.so",
                "libBambuSource.so",
            ], false, "runtime-linux-plugin"))
            : [];
        return [...pluginChecks, ...linuxPluginChecks, ...runtimeChecks];
    }
    if (platform === "win32") {
        const checks = checkFiles(pluginDir, [
            "pjarczak_bambu_networking_bridge.dll",
            "pjarczak_wsl_distro.txt",
            "install_runtime.ps1",
            "verify_runtime.ps1",
            "pjarczak_bambu_linux_host",
            "pjarczak_bambu_linux_host_abi1",
            "pjarczak_bambu_linux_host_abi0",
            "windows-wsl2-rootfs.tar",
            "ca-certificates.crt",
            "slicer_base64.cer",
            "pjarczak_plugin_cache_subdir.txt",
        ]);
        const bootstrap = ["pjarczak_wsl_run_host.sh", "pjarczak-wsl-run-host.sh"].map((name) => ({
            name,
            path: path.join(pluginDir, name),
            exists: fs.existsSync(path.join(pluginDir, name)),
            required: false,
        }));
        return [...checks, ...bootstrap];
    }
    return checkFiles(pluginDir, ["libbambu_networking.so", "libBambuSource.so"], false);
}
function setupCommands(platform, pluginDir, runtimeDir) {
    if (platform === "darwin") {
        const install = path.join(pluginDir, "install_runtime_macos.sh");
        const verify = path.join(pluginDir, "verify_runtime_macos.sh");
        const bridgeHost = path.join(runtimeDir || "", "pjarczak_bambu_linux_host");
        const wrapper = path.join(pluginDir, "pjarczak-bambu-linux-host-wrapper");
        return [
            {
                label: "install macOS Lima runtime",
                command: `bash ${quoteShell(install)} -PackageDir ${quoteShell(pluginDir)} -PluginDir ${quoteShell(pluginDir)}`,
            },
            {
                label: "verify macOS Lima runtime",
                command: `bash ${quoteShell(verify)} -PackageDir ${quoteShell(pluginDir)} -PluginDir ${quoteShell(pluginDir)}`,
            },
            {
                label: "verify macOS Lima runtime core before Linux plugin payload is present",
                command: `bash ${quoteShell(verify)} -PackageDir ${quoteShell(pluginDir)} -PluginDir ${quoteShell(pluginDir)} -AllowMissingLinuxPlugin`,
            },
            {
                label: "bridge command for FULU BambuNetwork runtime",
                command: `${quoteShell(wrapper)} ${quoteShell(bridgeHost)}`,
            },
        ];
    }
    if (platform === "win32") {
        return [
            {
                label: "enable WSL feature as Administrator",
                command: "dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart",
            },
            {
                label: "enable Virtual Machine Platform as Administrator",
                command: "dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart",
            },
            {
                label: "install WSL2 runtime after restart",
                command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quotePowerShell(path.join(pluginDir, "install_runtime.ps1"))} -PackageDir ${quotePowerShell(pluginDir)} -PluginDir ${quotePowerShell(pluginDir)}`,
            },
            {
                label: "verify WSL2 runtime",
                command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quotePowerShell(path.join(pluginDir, "verify_runtime.ps1"))} -PackageDir ${quotePowerShell(pluginDir)} -PluginDir ${quotePowerShell(pluginDir)}`,
            },
        ];
    }
    return [
        {
            label: "configure MCP slicer path",
            command: "SLICER_TYPE=orcaslicer-bambulab SLICER_PATH=/path/to/orcaslicer",
        },
    ];
}
function defaultBridgeCommand(platform, pluginDir, runtimeDir) {
    if (process.env.FULU_BAMBU_BRIDGE_COMMAND?.trim()) {
        return process.env.FULU_BAMBU_BRIDGE_COMMAND.trim();
    }
    if (!pluginDir) {
        return undefined;
    }
    if (platform === "darwin") {
        const wrapper = path.join(pluginDir, "pjarczak-bambu-linux-host-wrapper");
        const runtimeHost = path.join(runtimeDir || defaultRuntimeDir(platform) || "", "pjarczak_bambu_linux_host");
        return `${quoteShell(wrapper)} ${quoteShell(runtimeHost)}`;
    }
    if (platform === "linux") {
        const host = path.join(pluginDir, "pjarczak_bambu_linux_host");
        return fs.existsSync(host) ? quoteShell(host) : undefined;
    }
    return undefined;
}
function writeJsonRequestFrame(id, method, payload) {
    const body = Buffer.from(JSON.stringify({ method, payload }), "utf8");
    const header = Buffer.alloc(16);
    header.writeUInt32LE(BRIDGE_MAGIC, 0);
    header.writeUInt32LE(FRAME_TYPE_JSON_REQUEST, 4);
    header.writeUInt32LE(id, 8);
    header.writeUInt32LE(body.length, 12);
    return Buffer.concat([header, body]);
}
function parseBridgeFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset + 16 <= buffer.length) {
        const magic = buffer.readUInt32LE(offset);
        if (magic !== BRIDGE_MAGIC) {
            break;
        }
        const type = buffer.readUInt32LE(offset + 4);
        const id = buffer.readUInt32LE(offset + 8);
        const length = buffer.readUInt32LE(offset + 12);
        const payloadStart = offset + 16;
        const payloadEnd = payloadStart + length;
        if (payloadEnd > buffer.length) {
            break;
        }
        frames.push({ type, id, payload: buffer.subarray(payloadStart, payloadEnd) });
        offset = payloadEnd;
    }
    return frames;
}
async function runBridgeRequests(command, requests, timeoutMs) {
    if (!command.trim()) {
        throw new Error("bridge_command is required for the FULU BambuNetwork bridge.");
    }
    return await new Promise((resolve, reject) => {
        const child = spawn(command, {
            shell: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        let settled = false;
        const settle = (callback) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            callback();
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            settle(() => reject(new Error(`FULU bridge request timed out after ${timeoutMs}ms.`)));
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
        child.on("error", (error) => {
            settle(() => reject(error));
        });
        child.on("close", (code) => {
            const stdout = Buffer.concat(stdoutChunks);
            const stderr = Buffer.concat(stderrChunks).toString("utf8");
            const frames = parseBridgeFrames(stdout);
            const responses = {};
            const logs = [];
            for (const frame of frames) {
                if (frame.type === FRAME_TYPE_JSON_RESPONSE) {
                    try {
                        responses[String(frame.id)] = JSON.parse(frame.payload.toString("utf8"));
                    }
                    catch (error) {
                        responses[String(frame.id)] = {
                            ok: false,
                            error: `Invalid JSON response payload: ${error.message}`,
                            rawPayload: frame.payload.toString("utf8"),
                        };
                    }
                }
                else if (frame.type === FRAME_TYPE_LOG) {
                    logs.push(frame.payload.toString("utf8"));
                }
            }
            settle(() => resolve({
                exitCode: code,
                ok: code === 0 && requests.every((request) => Boolean(responses[String(request.id)])),
                stderr,
                logs,
                responses,
            }));
        });
        for (const request of requests) {
            child.stdin?.write(writeJsonRequestFrame(request.id, request.method, request.payload));
        }
        child.stdin?.end();
    });
}
async function probeFuluBridge(command, timeoutMs) {
    const probe = await runBridgeRequests(command, [
        { id: 1, method: "bridge.handshake", payload: {} },
        { id: 2, method: "bridge.capabilities", payload: {} },
        { id: 3, method: "bridge.runtime_info", payload: {} },
    ], timeoutMs);
    return {
        exitCode: probe.exitCode,
        ok: probe.ok && Boolean(probe.responses["1"]),
        stderr: probe.stderr,
        logs: probe.logs,
        handshake: probe.responses["1"] || null,
        capabilities: probe.responses["2"] || null,
        runtimeInfo: probe.responses["3"] || null,
    };
}
function isReadOnlyBridgeMethod(method) {
    return READ_ONLY_BRIDGE_METHODS.has(method) || READ_ONLY_NET_PREFIXES.some((prefix) => method.startsWith(prefix));
}
export async function invokeFuluBridgeRpc(options) {
    const method = options.method.trim();
    if (!method) {
        throw new Error("method is required.");
    }
    const readOnly = isReadOnlyBridgeMethod(method);
    const printMethod = isFuluPrintRpcMethod(method);
    if (!readOnly && !options.allowMutatingMethod) {
        throw new Error(`FULU bridge method "${method}" may mutate printer, account, or cloud state. ` +
            "Pass allow_mutating_method=true only when you intend to perform that action.");
    }
    if (printMethod && !options.bambuModel?.trim()) {
        throw new Error("bambu_model is required for FULU BambuNetwork print RPC methods.");
    }
    const command = options.bridgeCommand || process.env.FULU_BAMBU_BRIDGE_COMMAND || "";
    const bridgeResult = await runBridgeRequests(command, [{ id: 1, method, payload: options.payload || {} }], options.timeoutMs || 5000);
    return {
        method,
        readOnly,
        mutatingAllowed: Boolean(options.allowMutatingMethod),
        printMethod,
        bambuModel: options.bambuModel || undefined,
        exitCode: bridgeResult.exitCode,
        ok: bridgeResult.ok,
        stderr: bridgeResult.stderr,
        logs: bridgeResult.logs,
        response: bridgeResult.responses["1"] || null,
    };
}
export async function inspectFuluOrcaSetup(options) {
    const platform = normalizePlatform(options.platform);
    const slicerPath = resolveSlicerPath(options.slicerPath, platform);
    const pluginDir = derivePluginDir(options.pluginDir, slicerPath, platform);
    const runtimeDir = defaultRuntimeDir(platform, options.runtimeDir);
    const bridgeCommand = options.bridgeCommand || defaultBridgeCommand(platform, pluginDir, runtimeDir);
    const slicerExists = fs.existsSync(slicerPath);
    const fileChecks = platformFileChecks(platform, pluginDir, runtimeDir);
    const missingRequiredFiles = fileChecks
        .filter((entry) => entry.required && !entry.exists)
        .map((entry) => entry.name);
    const optionalMissingFiles = fileChecks
        .filter((entry) => !entry.required && !entry.exists)
        .map((entry) => entry.name);
    const commands = setupCommands(platform, pluginDir || "<FULU_ORCA_PLUGIN_DIR>", runtimeDir);
    let bridgeProbe;
    if (options.runBridgeProbe) {
        bridgeProbe = await probeFuluBridge(bridgeCommand || "", options.probeTimeoutMs || 5000);
    }
    const ready = slicerExists &&
        (platform === "linux" || (pluginDir.length > 0 && missingRequiredFiles.length === 0)) &&
        (!options.runBridgeProbe || Boolean(bridgeProbe?.ok));
    return {
        status: ready ? "ready" : "needs_setup",
        platform,
        slicer: {
            path: slicerPath,
            exists: slicerExists,
            slicerType: "orcaslicer-bambulab",
        },
        pluginDir: pluginDir || null,
        runtimeDir: runtimeDir || null,
        bridgeCommand: bridgeCommand || null,
        fileChecks,
        missingRequiredFiles,
        optionalMissingFiles,
        commands,
        bridgeProbe: bridgeProbe || null,
        mcpEnv: {
            PRINTER_TYPE: "bambu",
            SLICER_TYPE: "orcaslicer-bambulab",
            SLICER_PATH: slicerPath,
            FULU_ORCA_PLUGIN_DIR: pluginDir || undefined,
            FULU_BAMBU_BRIDGE_COMMAND: bridgeCommand || undefined,
        },
        bridgeRpc: {
            safeByDefault: true,
            readOnlyMethods: Array.from(READ_ONLY_BRIDGE_METHODS),
            readOnlyNetPrefixes: READ_ONLY_NET_PREFIXES,
            printMethodsRequireBambuModel: Array.from(FULU_PRINT_RPC_METHODS),
        },
        notes: [
            "Slicing support uses FULU OrcaSlicer-bambulab CLI output as a sliced 3MF.",
            "Bambu print start still enforces BAMBU_MODEL before generating or sending project G-code.",
            "The FULU BambuNetwork bridge is a separate runtime from the LAN MQTT/FTPS path; use bridge probing to verify that runtime before relying on cloud behavior.",
            "FULU macOS release bundles may ship the bridge dylib and host shims before the Linux plugin .so payload is present; missing linux-plugin entries mean the slicer can still be tested, but the BambuNetwork bridge is not fully ready.",
        ],
    };
}
