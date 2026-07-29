DOMAIN = 'eeve_mower_willow'
MANUFACTURER = "EEVE"
MODEL = "Willow"
NAME = "EEVE Mower"
CONF_MOWER_NAME = 'mower_name'
CONF_IP_ADDRESS = 'ip_address'

# hass.data key (top-level, not nested under DOMAIN's entry dict) holding a
# {ip_address: bool} map of whether the mowing motor is *meant* to be running,
# as last commanded via the switch. This is the source of truth the drive
# service uses to decide whether to re-engage the blade after a maneuver —
# it must NOT be confused with the switch's polled (rpm-based) state, which
# can read back "off" transiently (e.g. while driving backwards, where the
# blade is deliberately/legally forced off) even though the user still wants
# it on once forward driving resumes.
MOTOR_INTENT_DATA_KEY = "eeve_mower_willow_motor_intent"
