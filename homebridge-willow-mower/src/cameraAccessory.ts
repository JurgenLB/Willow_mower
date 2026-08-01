/**
 * WillowCameraAccessory
 *
 * Implements the HomeKit Camera protocol (HAP) for the Willow Mower's front camera.
 *
 * The mower exposes a JPEG snapshot endpoint:
 *   GET http://<ip>:8080/image/front/img.jpg
 *
 * HomeKit capabilities provided:
 *  • Snapshot (Still Image)  — served directly from the JPEG endpoint.
 *  • Live Stream (H.264/SRTP) — JPEG frames are fetched periodically from the
 *    mower and piped into ffmpeg, which encodes them as an H.264 SRTP stream
 *    delivered to the HomeKit controller.
 *
 * Requirements on the Homebridge host:
 *  • ffmpeg must be installed and on PATH (or configured via `ffmpegPath`).
 *    Linux:  sudo apt install ffmpeg
 *    macOS:  brew install ffmpeg
 */

import {
  CameraControllerOptions,
  CameraStreamingDelegate,
  H264Level,
  H264Profile,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
} from 'homebridge';
// CameraController is a value exported from hap-nodejs; access it at runtime
// via api.hap to avoid the TypeScript "exported as type only" error.
import type { CameraController } from 'homebridge';
import { ChildProcess, spawn } from 'child_process';
import { networkInterfaces } from 'os';
import { randomBytes } from 'crypto';
import http from 'http';

import { WillowMowerPlatform } from './platform';
import { MOWER_PORT } from './settings';

// ─── Session types ────────────────────────────────────────────────────────────

/**
 * Stored between prepareStream() and handleStreamRequest(START).
 * Contains everything ffmpeg needs to build the SRTP output URL.
 */
interface PendingSession {
  targetAddress: string;
  videoPort: number;
  videoSRTPKey: Buffer;
  videoSRTPSalt: Buffer;
  videoSSRC: number;
}

/** Running stream — stopped on STOP request or accessory teardown. */
interface ActiveSession {
  ffmpegProcess: ChildProcess;
  frameInterval: NodeJS.Timeout;
}

// ─── Camera accessory ─────────────────────────────────────────────────────────

export class WillowCameraAccessory implements CameraStreamingDelegate {
  /** The CameraController instance — type-annotated but created via api.hap at runtime. */
  public readonly controller: CameraController;

  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly activeSessions = new Map<string, ActiveSession>();

  private readonly ffmpegPath: string;
  private readonly streamFps: number;

  constructor(
    private readonly platform: WillowMowerPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ipAddress: string,
  ) {
    this.ffmpegPath =
      (platform.config['ffmpegPath'] as string | undefined) || 'ffmpeg';
    this.streamFps =
      (platform.config['streamFps'] as number | undefined) || 5;

    // ── AccessoryInformation ─────────────────────────────────────────────
    (
      this.accessory.getService(platform.Service.AccessoryInformation) ||
      this.accessory.addService(platform.Service.AccessoryInformation)
    )
      .setCharacteristic(platform.Characteristic.Manufacturer, 'EEVE')
      .setCharacteristic(platform.Characteristic.Model, 'Willow Camera')
      .setCharacteristic(platform.Characteristic.SerialNumber, `cam-${ipAddress}`);

    // ── CameraController setup ────────────────────────────────────────────
    const options: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 30],
            [1280, 720, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [320, 240, 15],
          ],
          codec: {
            profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
          },
        },
      },
    };

    this.controller = new platform.api.hap.CameraController(options);
    this.accessory.configureController(this.controller);
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ): void {
    this.platform.log.debug(
      'Snapshot request %dx%d from HomeKit',
      request.width,
      request.height,
    );

    this.fetchCameraFrame()
      .then(frame => callback(undefined, frame))
      .catch(err => {
        this.platform.log.error('Snapshot fetch failed: %s', (err as Error).message);
        callback(err as Error);
      });
  }

  // ── Stream prepare ────────────────────────────────────────────────────────

  prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): void {
    const sessionId = String(request.sessionID);

    // Generate our own SRTP key/salt for the outgoing video stream.
    const videoSRTPKey = randomBytes(16);
    const videoSRTPSalt = randomBytes(14);
    // Generate a random 32-bit SSRC (equivalent to CameraController.generateSynchronisationSource).
    const videoSSRC = randomBytes(4).readUInt32BE(0) >>> 0;

    this.pendingSessions.set(sessionId, {
      targetAddress: request.targetAddress,
      videoPort: request.video.port,
      videoSRTPKey,
      videoSRTPSalt,
      videoSSRC,
    });

    const localAddress = getLocalAddress(request.addressVersion);

    const response: PrepareStreamResponse = {
      addressOverride: localAddress,
      video: {
        port: request.video.port,
        ssrc: videoSSRC,
        srtp_key: videoSRTPKey,
        srtp_salt: videoSRTPSalt,
      },
    };

    this.platform.log.debug(
      'prepareStream: session=%s target=%s:%d local=%s',
      sessionId,
      request.targetAddress,
      request.video.port,
      localAddress,
    );

    callback(undefined, response);
  }

  // ── Stream control ────────────────────────────────────────────────────────

  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ): void {
    const sessionId = String(request.sessionID);

    switch (request.type) {
      case StreamRequestTypes.START: {
        const pending = this.pendingSessions.get(sessionId);
        if (!pending) {
          this.platform.log.error(
            'handleStreamRequest START: no pending session for %s',
            sessionId,
          );
          callback(new Error('No pending session'));
          return;
        }
        this.pendingSessions.delete(sessionId);
        this.startStream(sessionId, pending, request, callback);
        break;
      }

      case StreamRequestTypes.RECONFIGURE:
        // Acknowledge bitrate/resolution reconfiguration without restarting.
        // A production implementation could adjust ffmpeg parameters here.
        this.platform.log.debug('Stream RECONFIGURE for session %s', sessionId);
        callback();
        break;

      case StreamRequestTypes.STOP:
        this.platform.log.info('Stream STOP for session %s', sessionId);
        this.stopStream(sessionId);
        callback();
        break;
    }
  }

  // ── Internal: start ffmpeg stream ─────────────────────────────────────────

  private startStream(
    sessionId: string,
    session: PendingSession,
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ): void {
    // Pull video params from the START request.
    // The request is a StreamingRequest with type START, so video is present.
    const videoReq = (request as StreamingRequest & {
      video: { width: number; height: number; fps: number; max_bit_rate: number };
    }).video;

    const width = videoReq?.width || 1280;
    const height = videoReq?.height || 720;
    const fps = videoReq?.fps || this.streamFps;
    const bitrate = videoReq?.max_bit_rate || 299;

    // SRTP output params: key ++ salt, base64-encoded.
    const srtpParams = Buffer.concat([
      session.videoSRTPKey,
      session.videoSRTPSalt,
    ]).toString('base64');

    const srtpUrl =
      `srtp://${session.targetAddress}:${session.videoPort}` +
      `?pkt_size=1316`;

    const ffmpegArgs = [
      // Input: JPEG frames piped via stdin
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', String(fps),
      '-i', 'pipe:0',

      // Scale to the requested resolution
      '-vf', `scale=${width}:${height}`,

      // H.264 encoding
      '-vcodec', 'libx264',
      '-profile:v', 'baseline',
      '-level:v', '3.1',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-b:v', `${bitrate}k`,
      '-bufsize', `${bitrate * 2}k`,

      // RTP/SRTP output
      '-payload_type', '99',
      '-an',
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', srtpParams,
      srtpUrl,
    ];

    this.platform.log.debug(
      'Starting ffmpeg: %s %s',
      this.ffmpegPath,
      ffmpegArgs.join(' '),
    );

    const ffmpegProcess = spawn(this.ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      this.platform.log.debug('[ffmpeg] %s', data.toString().trimEnd());
    });

    ffmpegProcess.on('error', (err: NodeJS.ErrnoException) => {
      this.platform.log.error('ffmpeg process error: %s', err.message);
      if (err.code === 'ENOENT') {
        this.platform.log.error(
          'ffmpeg not found at "%s". ' +
          'Install it: Linux → sudo apt install ffmpeg | macOS → brew install ffmpeg. ' +
          'Or set "ffmpegPath" in the plugin config.',
          this.ffmpegPath,
        );
      }
      this.stopStream(sessionId);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      this.platform.log.debug(
        'ffmpeg exited: code=%s signal=%s session=%s',
        code,
        signal,
        sessionId,
      );
      this.activeSessions.delete(sessionId);
    });

    // Fetch JPEG frames from the mower and pipe them into ffmpeg stdin.
    const intervalMs = Math.max(50, Math.round(1000 / fps));

    const frameInterval = setInterval(async () => {
      if (
        !ffmpegProcess.stdin ||
        ffmpegProcess.stdin.destroyed ||
        ffmpegProcess.killed
      ) {
        return;
      }
      try {
        const frame = await this.fetchCameraFrame();
        if (!ffmpegProcess.stdin.destroyed) {
          ffmpegProcess.stdin.write(frame);
        }
      } catch {
        // Silently skip frames that fail to fetch; ffmpeg will stutter
        // momentarily but the stream will continue.
      }
    }, intervalMs);

    frameInterval.unref?.();

    this.activeSessions.set(sessionId, { ffmpegProcess, frameInterval });

    this.platform.log.info(
      'Stream started: %dx%d @ %dfps, %dkbps → %s:%d  (session %s)',
      width, height, fps, bitrate,
      session.targetAddress, session.videoPort,
      sessionId,
    );

    callback();
  }

  // ── Internal: stop ffmpeg stream ──────────────────────────────────────────

  private stopStream(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      clearInterval(active.frameInterval);

      if (active.ffmpegProcess.stdin && !active.ffmpegProcess.stdin.destroyed) {
        active.ffmpegProcess.stdin.destroy();
      }
      if (!active.ffmpegProcess.killed) {
        active.ffmpegProcess.kill('SIGKILL');
      }
      this.activeSessions.delete(sessionId);
      this.platform.log.debug('Stopped stream session %s', sessionId);
    }
    this.pendingSessions.delete(sessionId);
  }

  // ── Internal: fetch a single JPEG frame ───────────────────────────────────

  private fetchCameraFrame(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: this.ipAddress,
          port: MOWER_PORT,
          path: '/image/front/img.jpg',
          timeout: 5_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Camera frame fetch timeout'));
      });
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the first non-loopback IP address of the given family.
 * Used to tell HomeKit where to reach us (Homebridge server address).
 */
function getLocalAddress(addressVersion: string): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of (ifaces[name] ?? [])) {
      if (info.internal) continue;
      if (addressVersion === 'ipv6' && info.family === 'IPv6') return info.address;
      if (addressVersion !== 'ipv6' && info.family === 'IPv4') return info.address;
    }
  }
  return '0.0.0.0';
}
