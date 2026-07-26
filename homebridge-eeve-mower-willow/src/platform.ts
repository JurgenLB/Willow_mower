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
import { EeveMowerAccessory } from './mowerAccessory';
import { EeveCameraAccessory } from './cameraAccessory';

/**
 * EeveMowerPlatform
 *
 * Registered as a dynamic platform so Homebridge restores cached accessories
 * across restarts.  Two accessories are created per configured mower:
 *
 *  1. Mower accessory  – Switch (mowing on/off) + BatteryService
 *  2. Camera accessory – HomeKit camera with JPEG snapshot and H.264/SRTP
 *                        live-stream via ffmpeg
 */
export class EeveMowerPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  /** Accessories restored from Homebridge's persistent cache. */
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('EEVE Mower Willow platform initialising');

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
    const mowerName = (this.config['name'] as string | undefined) || 'EEVE Mower';

    if (!ipAddress) {
      this.log.error(
        'EEVE Mower Willow: no "ipAddress" configured. ' +
        'Add it to config.json under the EeveMowerWillow platform block.',
      );
      return;
    }

    this.log.info('Setting up EEVE Mower at %s', ipAddress);

    // ── Mower accessory (Switch + BatteryService) ──────────────────────────
    const mowerUUID = this.api.hap.uuid.generate(`eeve-mower-${ipAddress}`);
    const existingMower = this.accessories.find(a => a.UUID === mowerUUID);

    if (existingMower) {
      this.log.debug('Restoring mower accessory from cache: %s', existingMower.displayName);
      new EeveMowerAccessory(this, existingMower, ipAddress);
    } else {
      this.log.debug('Registering new mower accessory: %s', mowerName);
      const acc = new this.api.platformAccessory(mowerName, mowerUUID);
      new EeveMowerAccessory(this, acc, ipAddress);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    }

    // ── Camera accessory ───────────────────────────────────────────────────
    const cameraUUID = this.api.hap.uuid.generate(`eeve-camera-${ipAddress}`);
    const existingCamera = this.accessories.find(a => a.UUID === cameraUUID);
    const cameraName = `${mowerName} Camera`;

    if (existingCamera) {
      this.log.debug('Restoring camera accessory from cache: %s', existingCamera.displayName);
      new EeveCameraAccessory(this, existingCamera, ipAddress);
    } else {
      this.log.debug('Registering new camera accessory: %s', cameraName);
      const acc = new this.api.platformAccessory(cameraName, cameraUUID);
      new EeveCameraAccessory(this, acc, ipAddress);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    }
  }
}
