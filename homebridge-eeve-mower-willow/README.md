# homebridge-eeve-mower-willow

Homebridge plugin that exposes the **EEVE Mower Willow** to **HomeKit / Matter** via the mower's local REST API — no cloud required.

| HomeKit accessory | What it does |
|---|---|
| **Mower** (Switch) | ON = mowing, OFF = stopped. Tap to start or stop mowing. |
| **Mower** (Battery) | Battery level %, charging state and low-battery alert. |
| **Mower Camera** | Live view (H.264/SRTP) and still snapshots from the front camera. |

---

## Requirements

| Requirement | Notes |
|---|---|
| [Homebridge](https://homebridge.io) | v1.3.5 or newer |
| Node.js | v18 or newer |
| **ffmpeg** | Required for **live camera streaming** only. Snapshots work without it. |

### Install ffmpeg

```bash
# Raspberry Pi / Debian / Ubuntu
sudo apt update && sudo apt install -y ffmpeg

# macOS (Homebrew)
brew install ffmpeg
```

---

## Installation

### Via HACS / Homebridge UI (recommended)

1. Open **Homebridge UI** → **Plugins** → search `homebridge-eeve-mower-willow`.
2. Install and restart Homebridge.

### Manual install from this repository

```bash
# From the homebridge-eeve-mower-willow directory:
npm install
npm run build

# Then link it globally so Homebridge can find it:
npm link
```

Or install directly from GitHub:

```bash
npm install -g github:JurgenLB/eeve_mower_willow#main --prefix /path/to/homebridge/node_modules
```

---

## Configuration

Add the platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "EeveMowerWillow",
      "name": "EEVE Mower",
      "ipAddress": "192.168.1.100"
    }
  ]
}
```

### All options

| Key | Type | Default | Description |
|---|---|---|---|
| `platform` | string | **required** | Must be `"EeveMowerWillow"` |
| `name` | string | `"EEVE Mower"` | Display name in HomeKit |
| `ipAddress` | string | **required** | Local IP of the mower (port 8080) |
| `lowBatteryThreshold` | number | `20` | Battery % below which HomeKit shows low-battery alert |
| `ffmpegPath` | string | `"ffmpeg"` | Full path to the ffmpeg binary |
| `streamFps` | number | `5` | Frames per second for live stream (1–30) |

---

## How it works

### Battery & mower control

The plugin polls these REST endpoints every **30 seconds** (matching the HA integration):

| Endpoint | Used for |
|---|---|
| `GET /api/system/batteryStatus` | Battery level |
| `GET /api/system/dockingInfo` | Charging state |
| `GET /api/activities/info` | Mowing activity |
| `GET /api/toolplanner/status` | Active tool (most reliable for mowing state) |
| `PUT /api/navigation/startmowing?maxMowingTime=0` | Start mowing (Switch ON) |
| `PUT /api/navigation/stop` | Stop mowing (Switch OFF) |

### Camera

- **Snapshot** — `GET http://<ip>:8080/image/front/img.jpg` is served directly to HomeKit.
- **Live stream** — JPEG frames are fetched from the mower at the configured FPS, piped into `ffmpeg`, and encoded as H.264/SRTP before delivery to HomeKit.

```
Mower JPEG endpoint → [Node.js fetch loop] → ffmpeg stdin
                                              │ libx264 encode
                                              ↓
                                        SRTP/RTP → HomeKit
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Accessories not appearing | Check the `ipAddress` in config.json; verify the mower responds at `http://<ip>:8080/api/system/batteryStatus` |
| Camera snapshot fails | Confirm the mower is reachable and `http://<ip>:8080/image/front/img.jpg` loads in a browser |
| Live stream shows "Not Available" | Install ffmpeg (see above). Check Homebridge logs for `ffmpeg not found` |
| Battery always shows 0% | The mower may be unreachable — check network and firewall |

Enable debug logging in Homebridge (Settings → Debug mode) to see detailed poll and stream logs.

---

## License

GNU General Public License v3.0 — see [LICENSE](../LICENSE).
