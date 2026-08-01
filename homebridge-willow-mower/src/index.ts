import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { WillowMowerPlatform } from './platform';

/**
 * Homebridge entry point.  Called once when Homebridge loads the plugin.
 */
export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, WillowMowerPlatform);
};
