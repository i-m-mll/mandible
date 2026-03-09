import type { RouteRegistrar } from "../server.js";
/**
 * Parse the protected_branches setting value into a normalized array.
 * Trims whitespace, lowercases, and filters empty entries.
 */
export declare function parseProtectedBranches(value: string): string[];
/**
 * Get the list of protected branches from the settings table.
 * Falls back to ['main', 'develop'] if the setting is missing or empty.
 */
export declare function getProtectedBranches(): string[];
/** Get a boolean setting with fallback default. */
export declare function getBoolSetting(key: string, defaultValue: boolean): boolean;
/** Get an integer setting with fallback default. */
export declare function getIntSetting(key: string, defaultValue: number): number;
/** Get a string setting with fallback default. */
export declare function getStrSetting(key: string, defaultValue: string): string;
/**
 * Update a single variable in ~/.config/claude-reaper/config.
 * If the `export VAR=` line exists, replace its value; otherwise append it.
 * Creates the directory and file if they don't exist.
 */
export declare function dualWriteReaperConf(envVar: string, value: string): void;
/** Sync all reaper_* settings from DB to config file on startup. */
export declare function syncReaperSettingsToConfigFile(): void;
export declare function registerSettingsRoutes(server: RouteRegistrar): void;
