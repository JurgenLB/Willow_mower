"""EEVE Mower Willow Integration for Home Assistant."""
import json
import logging
import urllib.request

import aiohttp
import voluptuous as vol

from homeassistant import config_entries, core
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN, CONF_IP_ADDRESS, MOTOR_INTENT_DATA_KEY
from .coordinator import EeveMowerCoordinator, EeveMowerSystemCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[str] = [
    "lawn_mower",    # Native HA mower entity (start / dock / pause)
    "sensor",        # All numeric and text sensors
    "binary_sensor", # Boolean states (is_mowing, is_charging, has_error, ...)
    "button",        # Reboot, manual drive, sound buttons
    "camera",        # Front camera stream
    "select",        # Zone selection, mowing pattern, frequency, obstacle sensitivity
    "number",        # Max mowing time, drive speed, volume, thresholds
    "switch",        # Weekday mowing schedule (Mon-Sun)
    "text",          # Mower name
]

SERVICE_DRIVE = "drive"

DRIVE_SCHEMA = vol.Schema(
    {
        vol.Required("action"): vol.In(
            ["forward", "backwards", "spin", "stop"]
        ),
        vol.Optional("speed", default=0.2): vol.All(
            vol.Coerce(float), vol.Range(min=0.0, max=1.0)
        ),
        vol.Optional("distance", default=0.3): vol.All(
            vol.Coerce(float), vol.Range(min=0.0, max=5.0)
        ),
        vol.Optional("turn_radius", default=0.0): vol.All(
            vol.Coerce(float), vol.Range(min=-10.0, max=10.0)
        ),
        vol.Optional("rotation", default=0.0): vol.All(
            vol.Coerce(float), vol.Range(min=-360.0, max=360.0)
        ),
        vol.Optional("entry_id"): cv.string,
    }
)


def _resolve_ip(hass: core.HomeAssistant, data: dict) -> str | None:
    """Resolve the mower IP: explicit entry_id, else the first EEVE config entry."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        return None
    if data.get("entry_id"):
        for e in entries:
            if e.entry_id == data["entry_id"]:
                return e.data.get(CONF_IP_ADDRESS)
    return entries[0].data.get(CONF_IP_ADDRESS)


def _mowing_motor_should_be_on(hass: core.HomeAssistant, ip: str) -> bool:
    """Return True if the mowing motor is *meant* to be running for this mower.

    Used by the drive service to re-engage the cutting motor after a
    navigation command. The mower firmware appears to disengage the blade
    whenever a forward/spin maneuver is issued — even though manual driving
    mode itself stays active (mirroring MowingMotorSwitch.async_turn_on, which
    also has to re-issue startmower after entering manual mode). Without this,
    turning the motor on and then steering with the joystick turns the blade
    back off on the next status poll.

    This intentionally reads the intent flag set by MowingMotorSwitch
    (hass.data[MOTOR_INTENT_DATA_KEY]) rather than the switch's polled
    (rpm-based) state. The polled state can legitimately read "off" while the
    mower drives backwards (EU safety rules require the blade to be off
    during reverse — see the "backwards" handling below), even though the
    user's intent is still "on" once forward driving resumes. Reading the
    polled switch state here instead would fail to restart the blade after a
    reverse maneuver.
    """
    intent = hass.data.get(MOTOR_INTENT_DATA_KEY, {})
    if ip in intent:
        return bool(intent[ip])
    # Fallback for older/edge setups where the switch platform hasn't set the
    # intent flag yet: fall back to the switch entity's last known state.
    registry = er.async_get(hass)
    entity_id = registry.async_get_entity_id(
        "switch", DOMAIN, f"mowing_motor_{ip.replace('.', '_')}"
    )
    if not entity_id:
        return False
    state = hass.states.get(entity_id)
    return bool(state and state.state == "on")


def _register_drive_service(hass: core.HomeAssistant) -> None:
    """Register the eeve_mower.drive service (once)."""
    if hass.services.has_service(DOMAIN, SERVICE_DRIVE):
        return

    async def _handle_drive(call: core.ServiceCall) -> None:
        ip = _resolve_ip(hass, call.data)
        if not ip:
            _LOGGER.error("drive service: no EEVE mower configured")
            return
        action = call.data["action"]
        speed = call.data["speed"]
        host = f"http://{ip}:8080"
        # Firmware 6.8.0 endpoint quirks:
        #   forward   -> PUT  /api/navigation/forward
        #   backwards -> GET  /navigation/backwards   (the /api PUT variant is 404)
        #   spin      -> GET  /navigation/spinaround  (lowercase; /api & camelCase are 404)
        #   stop      -> PUT  /api/navigation/stop
        if action == "stop":
            method, url, params = "PUT", f"{host}/api/navigation/stop", {}
        elif action == "forward":
            method = "PUT"
            url = f"{host}/api/navigation/forward"
            # Curved driving uses turnRadius (signed): + = right, - = left,
            # smaller magnitude = tighter curve. This works reliably even when
            # streamed, unlike the rotation parameter.
            params = {
                "speed": speed,
                "distance": abs(call.data["distance"]),
                "turnRadius": call.data["turn_radius"],
            }
        elif action == "backwards":
            method = "GET"
            url = f"{host}/navigation/backwards"
            params = {
                "speed": speed,
                "distance": abs(call.data["distance"]),
                "turnRadius": call.data["turn_radius"],
            }
        else:  # spin (rotate in place)
            method = "GET"
            url = f"{host}/navigation/spinaround"
            params = {"speed": speed, "rotation": call.data["rotation"]}

        session = async_get_clientsession(hass)
        try:
            async with session.request(
                method,
                url,
                params=params,
                headers={"accept": "*/*"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    _LOGGER.warning("drive %s -> HTTP %s", action, resp.status)
        except aiohttp.ClientError as exc:
            _LOGGER.error("drive %s failed: %s", action, exc)
            return

        # Cutting-motor interlock.
        #
        # EU safety regulations require the cutting motor to be OFF whenever
        # the mower drives backwards — this is a hard safety/legal
        # requirement, not a "keep in sync with the switch" nicety. So for
        # "backwards" we unconditionally force the blade off, regardless of
        # what the mowing-motor switch's intent flag says.
        #
        # For forward/spin/stop, the firmware appears to disengage the blade
        # on ANY navigation command even though manual driving mode itself
        # stays active, so those re-engage the motor if it is meant to be on
        # (per the intent flag — see _mowing_motor_should_be_on) — that is
        # what brings the blade back once forward driving resumes after a
        # reverse maneuver.
        if action == "backwards":
            try:
                async with session.get(
                    f"{host}/navigation/stopmower",
                    headers={"accept": "*/*"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp2:
                    if resp2.status != 200:
                        _LOGGER.warning(
                            "drive backwards: forcing mowing motor off -> HTTP %s",
                            resp2.status,
                        )
            except aiohttp.ClientError as exc:
                _LOGGER.error("drive backwards: forcing mowing motor off failed: %s", exc)
        elif _mowing_motor_should_be_on(hass, ip):
            try:
                async with session.get(
                    f"{host}/navigation/startmower",
                    params={"throttle": 1.0},
                    headers={"accept": "*/*"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp2:
                    if resp2.status != 200:
                        _LOGGER.warning(
                            "drive %s: re-engaging mowing motor -> HTTP %s",
                            action, resp2.status,
                        )
            except aiohttp.ClientError as exc:
                _LOGGER.error("drive %s: re-engaging mowing motor failed: %s", action, exc)

    hass.services.async_register(
        DOMAIN, SERVICE_DRIVE, _handle_drive, schema=DRIVE_SCHEMA
    )
    _LOGGER.debug("Registered %s.%s service", DOMAIN, SERVICE_DRIVE)


SERVICE_SAVE_ZONES = "save_zones"

SAVE_ZONES_SCHEMA = vol.Schema(
    {
        vol.Required("geojson"): dict,  # a GeoJSON FeatureCollection
        vol.Optional("entry_id"): cv.string,
    }
)


def _register_save_zones_service(hass: core.HomeAssistant) -> None:
    """Register the eeve_mower_willow.save_zones service (once).

    Writes an edited zone FeatureCollection back to the mower via
    POST /settings/zones. The mower's /settings/* endpoints reject aiohttp
    POSTs ("Server disconnected"), so we use urllib in an executor thread.
    """
    if hass.services.has_service(DOMAIN, SERVICE_SAVE_ZONES):
        return

    async def _handle_save_zones(call: core.ServiceCall) -> None:
        ip = _resolve_ip(hass, call.data)
        if not ip:
            _LOGGER.error("save_zones: no EEVE mower configured")
            return
        geojson = call.data["geojson"]
        if not isinstance(geojson, dict) or "features" not in geojson:
            _LOGGER.error("save_zones: payload is not a GeoJSON FeatureCollection")
            return
        url = f"http://{ip}:8080/settings/zones"
        body = json.dumps(geojson).encode("utf-8")

        def _post() -> int:
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"Content-Type": "application/json", "accept": "*/*"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status

        try:
            status = await hass.async_add_executor_job(_post)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.error("save_zones failed: %s", exc)
            return
        if status == 200:
            _LOGGER.info("save_zones: saved %d features", len(geojson.get("features", [])))
            # Refresh the system coordinator so the zone_map sensor updates.
            for store in hass.data.get(DOMAIN, {}).values():
                if isinstance(store, dict) and "system_coordinator" in store:
                    hass.async_create_task(
                        store["system_coordinator"].async_request_refresh()
                    )
        else:
            _LOGGER.error("save_zones: HTTP %s", status)

    hass.services.async_register(
        DOMAIN, SERVICE_SAVE_ZONES, _handle_save_zones, schema=SAVE_ZONES_SCHEMA
    )
    _LOGGER.debug("Registered %s.%s service", DOMAIN, SERVICE_SAVE_ZONES)


async def async_setup(hass: core.HomeAssistant, config: dict) -> bool:
    """Set up the EEVE Mower Willow component."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(
    hass: core.HomeAssistant, entry: config_entries.ConfigEntry
) -> bool:
    """Set up EEVE Mower Willow from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    ip_address = entry.data[CONF_IP_ADDRESS]

    fast_coordinator = EeveMowerCoordinator(hass, entry, ip_address)
    system_coordinator = EeveMowerSystemCoordinator(hass, entry, ip_address)

    hass.data[DOMAIN][entry.entry_id] = {
        "coordinator": fast_coordinator,
        "system_coordinator": system_coordinator,
        "ip": ip_address,
    }

    _LOGGER.info("Setting up %s (IP: %s)", DOMAIN, ip_address)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    _register_drive_service(hass)
    _register_save_zones_service(hass)

    hass.async_create_task(fast_coordinator.async_request_refresh())
    hass.async_create_task(system_coordinator.async_request_refresh())

    return True


async def async_unload_entry(
    hass: core.HomeAssistant, entry: config_entries.ConfigEntry
) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
        # Remove the service when the last mower is unloaded
        if not hass.config_entries.async_entries(DOMAIN):
            hass.services.async_remove(DOMAIN, SERVICE_DRIVE)
            hass.services.async_remove(DOMAIN, SERVICE_SAVE_ZONES)
    return unload_ok
