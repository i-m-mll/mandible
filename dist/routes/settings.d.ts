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
export declare function registerSettingsRoutes(server: RouteRegistrar): void;
