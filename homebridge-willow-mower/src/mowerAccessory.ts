/**
 * WillowMowerAccessory
 *
 * Exposes two HomeKit services:
 *  - Switch        → ON while the mower is actively mowing; set ON to start
 *                    mowing, set OFF to stop.
 *  - BatteryService→ battery level, charging state and low-battery alert.
 *
 * Data is polled every 30 seconds from the mower's local REST API
 * (http://<ip>:8080) — identical to the Home Assistant integration.
 */

import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import http from 'http';
import { WillowMowerPlatform } from './platform';
import {
  DEFAULT_LOW_BATTERY_THRESHOLD,
  HardwareInfo,
  MOWER_PORT,
  POLL_INTERVAL_MS,
} from './settings';

// ─── Mower REST response shapes ─────────────────────────────────────────────

interface BatteryStatus {
  percentage?: number;
  availableMowingTime?: number;
}

interface ActivitiesInfo {
  userActivity?: string;
  scheduledActivity?: string;
}

interface DockingInfo {
  dockingState?: string;
  chargeStatus?: string;
}

interface ToolPlannerStatus {
  tools?: Array<{ name: string; active: boolean }>;
}

// ─── Accessory ───────────────────────────────────────────────────────────────

export class WillowMowerAccessory {
  private readonly switchService: Service;
  private readonly batteryService: Service;

  /** Cached state — updated by the poll loop */
  private isMowing = false;
  private batteryLevel = 0;
  private isCharging = false;

  private readonly lowBatteryThreshold: number;
  private readonly pollTimer: NodeJS.Timeout;

  constructor(
    private readonly platform: WillowMowerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ipAddress: string,
  ) {
    const { Service, Characteristic } = this.platform;

    this.lowBatteryThreshold =
      (this.platform.config['lowBatteryThreshold'] as number | undefined) ??
      DEFAULT_LOW_BATTERY_THRESHOLD;

    // ── AccessoryInformation ─────────────────────────────────────────────
    (
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation)
    )
      .setCharacteristic(Characteristic.Manufacturer, 'EEVE')
      .setCharacteristic(Characteristic.Model, 'Willow');

    // ── Switch (mowing control) ──────────────────────────────────────────
    this.switchService =
      this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch, 'Mowing');

    this.switchService
      .getCharacteristic(Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));

    // ── BatteryService ───────────────────────────────────────────────────
    this.batteryService =
      this.accessory.getService(Service.Battery) ||
      this.accessory.addService(Service.Battery);

    // Seed battery characteristics with safe defaults so HomeKit shows
    // something before the first poll completes.
    this.batteryService
      .updateCharacteristic(Characteristic.BatteryLevel, 0)
      .updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGING)
      .updateCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

    // ── Start polling ─────────────────────────────────────────────────────
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    // Prevent the interval from blocking Node.js exit (relevant for tests).
    this.pollTimer.unref();

    // ── Populate AccessoryInformation from hardware endpoint ──────────────
    this.initHardwareInfo();
  }

  // ── Characteristic handlers ────────────────────────────────────────────────

  private async initHardwareInfo(): Promise<void> {
    try {
      const info = await this.fetchJson<HardwareInfo>('/api/system/hardwareInfo');
      const serial = info.serialNumber ? info.serialNumber.slice(-4) : '';
      const { Characteristic } = this.platform;
      const infoService =
        this.accessory.getService(this.platform.Service.AccessoryInformation);
      if (infoService) {
        if (serial) {
          infoService.updateCharacteristic(Characteristic.SerialNumber, serial);
        }
        if (info.hardwareVersion) {
          infoService.updateCharacteristic(Characteristic.FirmwareRevision, info.hardwareVersion);
        }
      }
      this.platform.log.debug('Hardware info loaded: serial=%s MAC=%s fw=%s', serial, info.uniqueHardwareId, info.hardwareVersion);
    } catch (err) {
      this.platform.log.warn('Failed to load hardware info: %s', (err as Error).message);
    }
  }

  private handleOnGet(): CharacteristicValue {
    return this.isMowing;
  }

  private async handleOnSet(value: CharacteristicValue): Promise<void> {
    const startMowing = value as boolean;
    this.platform.log.info(
      'Mower %s: %s mowing via HomeKit',
      this.ipAddress,
      startMowing ? 'starting' : 'stopping',
    );

    try {
      if (startMowing) {
        await this.httpPut('/api/navigation/startmowing?maxMowingTime=0');
      } else {
        // Stop navigation then send home
        await this.httpPut('/api/navigation/stop');
      }
    } catch (err) {
      this.platform.log.error('Mower command failed: %s', (err as Error).message);
    }

    // Refresh state shortly after the command so the switch reflects reality.
    setTimeout(() => this.poll(), 3000);
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const [batteryResult, activitiesResult, dockingResult, toolplannerResult] =
        await Promise.allSettled([
          this.fetchJson<BatteryStatus>('/api/system/batteryStatus'),
          this.fetchJson<ActivitiesInfo>('/api/activities/info'),
          this.fetchJson<DockingInfo>('/api/system/dockingInfo'),
          this.fetchJson<ToolPlannerStatus>('/api/toolplanner/status'),
          this.fetchJson<HardwareInfo>('/api/system/hardwareInfo'),
        ]);

      // ── Battery ──────────────────────────────────────────────────────────
      if (batteryResult.status === 'fulfilled') {
        this.batteryLevel = batteryResult.value.percentage ?? this.batteryLevel;
      }

      // ── Charging state ────────────────────────────────────────────────────
      if (dockingResult.status === 'fulfilled') {
        const chargeStatus = (dockingResult.value.chargeStatus ?? '').toLowerCase();
        this.isCharging = chargeStatus.includes('charging');
      }

      // ── Mowing state — prefer toolplanner, fall back to activities ────────
      let mowing = false;
      if (toolplannerResult.status === 'fulfilled') {
        const tools = toolplannerResult.value.tools ?? [];
        mowing = tools.some(
          t => t.active && (t.name === 'mowing' || t.name === 'MowingPlannerTool'),
        );
      }
      if (!mowing && activitiesResult.status === 'fulfilled') {
        const a = activitiesResult.value;
        mowing =
          a.userActivity === 'MowActivity' ||
          a.scheduledActivity === 'MowingPlannerActivity' ||
          a.scheduledActivity === 'MowActivity';
      }
      this.isMowing = mowing;

      // ── Push updates to HomeKit ───────────────────────────────────────────
      const { Characteristic } = this.platform;

      this.switchService.updateCharacteristic(Characteristic.On, this.isMowing);

      this.batteryService
        .updateCharacteristic(Characteristic.BatteryLevel, this.batteryLevel)
        .updateCharacteristic(
          Characteristic.ChargingState,
          this.isCharging
            ? Characteristic.ChargingState.CHARGING
            : Characteristic.ChargingState.NOT_CHARGING,
        )
        .updateCharacteristic(
          Characteristic.StatusLowBattery,
          this.batteryLevel < this.lowBatteryThreshold
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );

      this.platform.log.debug(
        'Poll OK — battery: %d%%, charging: %s, mowing: %s',
        this.batteryLevel,
        this.isCharging,
        this.isMowing,
      );
    } catch (err) {
      this.platform.log.warn('Mower poll error: %s', (err as Error).message);
    }
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  private fetchJson<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: this.ipAddress,
          port: MOWER_PORT,
          path,
          headers: { accept: 'application/json' },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Timeout fetching ${path}`));
      });
    });
  }

  private httpPut(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.ipAddress,
          port: MOWER_PORT,
          path,
          method: 'PUT',
          headers: { accept: '*/*' },
          timeout: 10_000,
        },
        (res) => {
          res.resume(); // drain the response body
          resolve();
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Timeout on PUT ${path}`));
      });
      req.end();
    });
  }
}
