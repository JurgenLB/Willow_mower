export const PLATFORM_NAME = 'WillowMower';
export const PLUGIN_NAME = 'homebridge-willow-mower';

/** REST API base port on the mower */
export const MOWER_PORT = 8080;

/** Fast-poll interval matching the HA integration (30 s) */
export const POLL_INTERVAL_MS = 30_000;

/** Default low-battery threshold (%) */
export const DEFAULT_LOW_BATTERY_THRESHOLD = 20;
