import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { WillowMowerAccessory } from './mowerAccessory';
import { WillowCameraAccessory } from './cameraAccessory';

/**
 * WillowMowerPlatform
 *
 * Registered as a dynamic platform so Homebridge restores cached accessories
 * across restarts.  Two accessories are created per configured mower:
 *
 *  1. Mower accessory  – Switch (mowing on/off) + BatteryService
 *  2. Camera accessory – HomeKit camera with JPEG snapshot and H.264/SRTP
 *                        live-stream via ffmpeg
 */
export class WillowMowerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  /** Accessories restored from Homebridge's persistent cache. */
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Willow Mower platform initialising');

    // Wait until Homebridge has finished loading cached accessories before
    // creating new ones.
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  /**
   * Called by Homebridge for every accessory it finds in the cache.
   * Store them so `discoverDevices` can match them against discovered devices.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring cached accessory: %s', accessory.displayName);
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    const ipAddress = this.config['ipAddress'] as string | undefined;
    const mowerName = (this.config['name'] as string | undefined) || 'Willow Mower';

    if (!ipAddress) {
      this.log.error(
        'Willow Mower: no "ipAddress" configured. ' +
        'Add it to config.json under the WillowMower platform block.',
      );
      return;
    }

    this.log.info('Setting up Willow Mower at %s', ipAddress);

    // ── Mower accessory (Switch + BatteryService) ──────────────────────────
    const mowerUUID = this.api.hap.uuid.generate(`willow-mower-${ipAddress}`);
    const existingMower = this.accessories.find(a => a.UUID === mowerUUID);

    if (existingMower) {
      this.log.debug('Restoring mower accessory from cache: %s', existingMower.displayName);
      new WillowMowerAccessory(this, existingMower, ipAddress);
    } else {
      this.log.debug('Registering new mower accessory: %s', mowerName);
      const acc = new this.api.platformAccessory(mowerName, mowerUUID);
      new WillowMowerAccessory(this, acc, ipAddress);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    }

    // ── Camera accessory ───────────────────────────────────────────────────
    const cameraUUID = this.api.hap.uuid.generate(`willow-camera-${ipAddress}`);
    const existingCamera = this.accessories.find(a => a.UUID === cameraUUID);
    const cameraName = `${mowerName} Camera`;

    if (existingCamera) {
      this.log.debug('Restoring camera accessory from cache: %s', existingCamera.displayName);
      new WillowCameraAccessory(this, existingCamera, ipAddress);
    } else {
      this.log.debug('Registering new camera accessory: %s', cameraName);
      const acc = new this.api.platformAccessory(cameraName, cameraUUID);
      new WillowCameraAccessory(this, acc, ipAddress);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    }
  }
}
