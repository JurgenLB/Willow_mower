"""Text entities for EEVE Mower Willow.

MowerNameText  – Name des Mähers (frei wählbar).
                 GET/POST /settings/identity/name
                 Antwort/Body: JSON string

ZoneNameText   – Name einer Mähzone (frei wählbar), pro GRASSZONE.
                 Liest/schreibt ``properties.customName`` in /settings/zones.
                 Created dynamically like the per-zone select/number entities:
                 one per zone known at startup, plus new ones for zones added
                 later (e.g. cloned via the map card) via the system
                 coordinator's refresh — see the listener in async_setup_entry.
"""
from __future__ import annotations

import asyncio
import logging
import json
import urllib.request
import aiohttp

from homeassistant.components.text import TextEntity, TextMode
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, CONF_IP_ADDRESS, MANUFACTURER, MODEL, NAME
from .coordinator import EeveMowerSystemCoordinator, async_fetch_zone_settings

_LOGGER = logging.getLogger(__name__)


async def _post_zones_urllib(url: str, zone_data: dict) -> int:
    """POST zone data using urllib (the mower's /settings/* endpoints reject
    aiohttp POSTs with "Server disconnected" — see select.py/number.py)."""
    payload = json.dumps(zone_data).encode("utf-8")

    def _do_post():
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "accept": "application/json",
                "Connection": "close",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status

    return await asyncio.get_event_loop().run_in_executor(None, _do_post)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up EEVE Mower text entities."""
    ip_address = entry.data[CONF_IP_ADDRESS]
    system_coord: EeveMowerSystemCoordinator = hass.data[DOMAIN][entry.entry_id][
        "system_coordinator"
    ]

    entities: list[TextEntity] = [MowerNameText(ip_address)]

    # --- per-zone name text entities (one per GRASSZONE) ---
    #
    # Same dynamic-discovery pattern as the per-zone select/number entities
    # (see select.py/number.py): enumerated once at startup, plus a listener
    # that adds entities for zones that appear later (e.g. cloned via the map
    # card), piggy-backing on the system coordinator refresh already
    # triggered by the eeve_mower_willow.save_zones service.
    known_zone_ids: set[str] = set()

    def _zone_entities(zone_id: str, zone_name: str) -> list[TextEntity]:
        return [ZoneNameText(system_coord, ip_address, zone_id, zone_name)]

    zone_list = await async_fetch_zone_settings(ip_address)
    for zone_id, zone_name, _zone_props in zone_list:
        entities.extend(_zone_entities(zone_id, zone_name))
        known_zone_ids.add(zone_id)

    async_add_entities(entities)

    @callback
    def _discover_new_zones() -> None:
        """Add a name text entity for any zone not seen at startup."""
        zone_data = (system_coord.data or {}).get("zone_settings", {})
        new_entities: list[TextEntity] = []
        for feature in zone_data.get("features", []):
            props = feature.get("properties", {})
            if props.get("zoneType") != "GRASSZONE":
                continue
            zid = feature.get("id")
            if not zid or zid in known_zone_ids:
                continue
            zname = props.get("customName") or props.get("name") or zid
            new_entities.extend(_zone_entities(zid, zname))
            known_zone_ids.add(zid)
        if new_entities:
            _LOGGER.info(
                "Discovered %d new zone(s) -> adding %d name text entities",
                len(new_entities),
                len(new_entities),
            )
            async_add_entities(new_entities)

    entry.async_on_unload(system_coord.async_add_listener(_discover_new_zones))


# ---------------------------------------------------------------------------
# Mower name text entity
# ---------------------------------------------------------------------------

class MowerNameText(TextEntity):

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "mower_name"
    """Editable name of the mower (shown in the EEVE app).

    GET  /settings/identity/name  → JSON string
    POST /settings/identity/name  → Body: JSON string
    """

    _attr_icon = "mdi:robot-mower"
    _attr_mode = TextMode.TEXT
    _attr_native_min = 1
    _attr_native_max = 64

    _ENDPOINT = "/settings/identity/name"

    def __init__(self, ip_address: str) -> None:
        self._ip_address = ip_address
        self._attr_native_value: str = "EEVE Mower"
        self._attr_unique_id = f"mower_name_{ip_address.replace('.', '_')}"
        self._device_id = f"eeve_mower_{ip_address.replace('.', '_')}"

    @property
    def device_info(self) -> dict:
        return {
            "identifiers": {(DOMAIN, self._device_id)},
            "name": NAME,
            "manufacturer": MANUFACTURER,
            "model": MODEL,
        }

    async def async_update(self) -> None:
        """Read current mower name from the device."""
        url = f"http://{self._ip_address}:8080{self._ENDPOINT}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers={"accept": "application/json"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        value = await resp.json()
                        if isinstance(value, str) and value:
                            self._attr_native_value = value
        except (aiohttp.ClientError, Exception) as exc:
            _LOGGER.debug("Could not read mower name: %s", exc)

    async def async_set_value(self, value: str) -> None:
        """Send new mower name to the device."""
        url = f"http://{self._ip_address}:8080{self._ENDPOINT}"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    headers={
                        "accept": "application/json",
                        "Content-Type": "application/json",
                    },
                    data=json.dumps(value),
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status == 200:
                        self._attr_native_value = value
                        self.async_write_ha_state()
                        _LOGGER.info("Mower name set to '%s'", value)
                    else:
                        _LOGGER.error(
                            "Set mower name failed: HTTP %s", resp.status
                        )
        except aiohttp.ClientError as exc:
            _LOGGER.error("Set mower name failed: %s", exc)


# ---------------------------------------------------------------------------
# Per-zone name text entity
# ---------------------------------------------------------------------------

class ZoneNameText(TextEntity):

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.CONFIG
    _attr_translation_key = "zone_name"
    """Editable display name for a specific grass zone (e.g. renaming "Grass 1"
    to "Front Lawn"), mirroring what the map card's rename/clone-name prompt
    already does, but reachable directly from the integration (an entity,
    usable in automations/scripts too) instead of only via the map.

    Reads:  system-coordinator ``zone_settings`` key (refreshed every 5 min).
    Writes: GET /settings/zones → modify properties.customName →
            POST /settings/zones (via urllib — see _post_zones_urllib;
            the mower's /settings/* endpoints reject aiohttp POSTs).
    """

    _attr_icon = "mdi:form-textbox"
    _attr_mode = TextMode.TEXT
    _attr_native_min = 1
    _attr_native_max = 64
    should_poll = False

    def __init__(
        self,
        system_coordinator: EeveMowerSystemCoordinator,
        ip_address: str,
        zone_id: str,
        zone_name: str,
    ) -> None:
        self._system_coordinator = system_coordinator
        self._ip_address = ip_address
        self._zone_id = zone_id
        self._attr_native_value = zone_name
        safe = zone_id.lower().replace(" ", "_")
        self._attr_unique_id = f"zone_name_{ip_address.replace('.', '_')}_{safe}"
        self._device_id = f"eeve_mower_{ip_address.replace('.', '_')}"
        # Note: like the other per-zone entities, this placeholder is fixed
        # at creation time — if the zone is renamed (via this entity or the
        # map card), the *entity's own* friendly name label ("<old name>
        # Name") only catches up after a HA restart. The native_value
        # (i.e. the actual text shown/edited) always reflects the current
        # name, which is what matters for actually renaming the zone.
        self._attr_translation_placeholders = {"zone_name": zone_name}

    @property
    def device_info(self) -> dict:
        return {
            "identifiers": {(DOMAIN, self._device_id)},
            "name": NAME,
            "manufacturer": MANUFACTURER,
            "model": MODEL,
        }

    # ------------------------------------------------------------------
    # Coordinator listener
    # ------------------------------------------------------------------

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self._system_coordinator.async_add_listener(
                self._handle_coordinator_update
            )
        )
        if self._system_coordinator.data:
            self._apply_coordinator_data(self._system_coordinator.data)
            self.async_write_ha_state()

    @callback
    def _handle_coordinator_update(self) -> None:
        if self._system_coordinator.data:
            self._apply_coordinator_data(self._system_coordinator.data)
        self.async_write_ha_state()

    def _apply_coordinator_data(self, data: dict) -> None:
        """Pick up this zone's customName from the cached GeoJSON — e.g. if
        it was renamed via the map card instead of this entity."""
        zone_settings = data.get("zone_settings")
        if not isinstance(zone_settings, dict):
            return
        for feature in zone_settings.get("features", []):
            if feature.get("id") != self._zone_id:
                continue
            props = feature.get("properties", {})
            name = props.get("customName") or props.get("name")
            if name:
                self._attr_native_value = name
            return

    # ------------------------------------------------------------------
    # Rename
    # ------------------------------------------------------------------

    async def async_set_value(self, value: str) -> None:
        """Rename this zone on the mower."""
        value = value.strip()
        if not value:
            _LOGGER.error("Zone rename: name must not be empty")
            return
        url = f"http://{self._ip_address}:8080/settings/zones"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    headers={"accept": "application/json"},
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        _LOGGER.error(
                            "GET /settings/zones failed: HTTP %s", resp.status
                        )
                        return
                    zone_data = await resp.json()
        except aiohttp.ClientError as exc:
            _LOGGER.error("GET /settings/zones failed: %s", exc)
            return

        found = False
        for feature in zone_data.get("features", []):
            if feature.get("id") != self._zone_id:
                continue
            props = feature.setdefault("properties", {})
            props["customName"] = value
            found = True
            break
        if not found:
            _LOGGER.error(
                "Zone %s not found in /settings/zones response", self._zone_id
            )
            return

        try:
            status = await _post_zones_urllib(url, zone_data)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.error("POST /settings/zones failed: %s", exc)
            return
        if status == 200:
            self._attr_native_value = value
            self.async_write_ha_state()
            _LOGGER.info("Zone %s renamed -> '%s'", self._zone_id, value)
            # Refresh the system coordinator so the map card and other
            # per-zone entities' cached zone_settings pick up the new name
            # right away, instead of waiting for the next 5-minute poll.
            await self._system_coordinator.async_request_refresh()
        else:
            _LOGGER.error("POST /settings/zones failed: HTTP %s", status)
