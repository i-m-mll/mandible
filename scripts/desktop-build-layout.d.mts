export const daemonBuildOutput: string;
export const frontendBuildOutput: string;
export function desktopPackageEnvironment(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function desktopAppPath(root: string, options?: {
  env?: NodeJS.ProcessEnv; profile?: string; target?: string | null; product?: string;
}): string;
export function acceptanceBuildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function acceptanceBuildOutputs(root: string): string[];
