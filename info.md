# EEVE Mower Willow - Home Assistant Integration

Control and monitor your EEVE Willow lawn mower directly from Home Assistant — status,
battery, per-zone settings, manual driving, map exploration and more. Mowing is controlled
through a standard Home Assistant **lawn mower** entity (start / pause / dock).

**New in v0.5.0:** rename grass zones straight from Home Assistant, zones added or cloned on
the mower show up without a restart, and the new `save_zones` service writes zone geometry
back to the mower. Pair it with the
[EEVE Mower Card](https://github.com/flame4ever/eeve_mower_willow_card) (v0.2.0+) for a full
control panel and a map with a zone editor.

> Entity IDs below use the default `eeve_mower` / `mower` prefix. Adjust them to match your
> mower's name in your setup.

## Automation Examples

### Start mowing in the morning
```yaml
- alias: Mower - Start mowing in the morning
  id: 12345678-1234-1234-1234-123456789abc # Make this unique
  trigger:
    - platform: time
      at: "08:00:00"
  action:
    - service: lawn_mower.start_mowing
      target:
        entity_id: lawn_mower.eeve_mower
```

### Notification when mowing starts
```yaml
- alias: Mower - Notification when mowing starts
  id: 23456789-2345-2345-2345-234567890bcd # Make this unique
  trigger:
    - platform: state
      entity_id: binary_sensor.eeve_mower_is_mowing
      to: "on"
  action:
    - service: notify.mobile_app_your_phone_app # Change to your device
      data:
        message: "Willow started mowing."
```

### Notification when fully charged
```yaml
- alias: Mower - Notification when fully charged
  id: 34567890-3456-3456-3456-345678901cde # Make this unique
  trigger:
    - platform: numeric_state
      entity_id: sensor.mower_battery
      above: 99
  action:
    - service: notify.mobile_app_your_phone_app # Change to your device
      data:
        message: "Willow is fully charged."
```

### Dock the mower when it starts raining
```yaml
- alias: Mower - Dock when raining
  id: 45678901-4567-4567-4567-456789012def # Make this unique
  trigger:
    - platform: state
      entity_id: sensor.eeve_mower_rain_sensor
      to: "wet" # adjust to your rain sensor's value
  action:
    - service: lawn_mower.dock
      target:
        entity_id: lawn_mower.eeve_mower
```

### Rename a zone
```yaml
- alias: Mower - Rename zone for the season
  id: 56789012-5678-5678-5678-567890123ef0 # Make this unique
  trigger:
    - platform: time
      at: "04:00:00"
  condition:
    - condition: template
      value_template: "{{ now().month == 4 and now().day == 1 }}"
  action:
    - service: text.set_value
      target:
        entity_id: text.eeve_mower_grass_1_name # adjust to your zone
      data:
        value: "Front lawn (spring)"
```

### Notify when a new zone appears
```yaml
- alias: Mower - Notify on new zone
  id: 67890123-6789-6789-6789-678901234f01 # Make this unique
  trigger:
    - platform: state
      entity_id: sensor.eeve_mower_zones_count
  condition:
    - condition: template
      value_template: "{{ trigger.to_state.state | int > trigger.from_state.state | int }}"
  action:
    - service: notify.mobile_app_your_phone_app # Change to your device
      data:
        message: "A new mowing zone was created ({{ trigger.to_state.state }} total)."
```

## Companion cards

```yaml
# full control panel — put this in a Panel view
type: custom:eeve-mower-card
```

```yaml
# satellite map with zone editor
type: custom:eeve-mower-map-card
```

Both come from the
[EEVE Mower Card](https://github.com/flame4ever/eeve_mower_willow_card) repository.

## Lovelace Example
```yaml
type: vertical-stack
cards:
  - type: tile
    entity: lawn_mower.eeve_mower
    features:
      - type: lawn-mower-commands
        commands:
          - start_pause
          - dock
  - type: entities
    title: Mower Info
    entities:
      - entity: sensor.mower_battery
        name: Battery
      - entity: sensor.mower_activities
        name: Activity
      - entity: sensor.eeve_mower_current_mowing_zone
        name: Current Zone
      - entity: sensor.eeve_mower_rain_sensor
        name: Rain Sensor
  - type: horizontal-stack
    cards:
      - type: button
        entity: button.eeve_mower_hard_emergency_stop
        name: Emergency Stop
      - type: button
        entity: button.eeve_mower_start_docking
        name: Dock
```
