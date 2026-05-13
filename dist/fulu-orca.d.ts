export type FuluOrcaSetupOptions = {
    slicerPath?: string;
    pluginDir?: string;
    runtimeDir?: string;
    platform?: string;
    bridgeCommand?: string;
    runBridgeProbe?: boolean;
    probeTimeoutMs?: number;
};
export type FuluBridgeRpcOptions = {
    bridgeCommand?: string;
    method: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
    allowMutatingMethod?: boolean;
    bambuModel?: string;
};
export declare function isFuluPrintRpcMethod(method: string): boolean;
export declare function invokeFuluBridgeRpc(options: FuluBridgeRpcOptions): Promise<Record<string, unknown>>;
export declare function inspectFuluOrcaSetup(options: FuluOrcaSetupOptions): Promise<Record<string, unknown>>;
