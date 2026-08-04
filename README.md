# Watchplug

A LuCI app for OpenWrt that drives an **HTTP-controlled device** from the connectivity state of a
**router interface**.

The obvious use is rebooting an upstream modem through a smart plug when the WAN dies, which is
the escalation layer above `watchcat`: watchcat restarts the interface, Watchplug restarts the
hardware when that is not enough. Nothing in the app is tied to that scenario — any interface,
any HTTP device.

Built for OpenWrt 21.02 and its LuCI client-side JS. The package is architecture `all` — pure
shell and JavaScript — so it installs on any target without an SDK or cross-compilation.

## Supported devices

- **Tasmota** (built-in preset): address, relay and optional credentials, nothing else to fill in.
- **Anything else with an HTTP API**: give it switch-on / switch-off / cycle / state URLs, with
  `{host} {port} {user} {password} {off_time} {off_ds}` placeholders. Shelly native, relay boards,
  a home-automation hub endpoint, your own CGI script.

## What sets it apart from a cron job and a curl call

- **Checks are sent out of the monitored device itself** (`ping -I pppoe-wan …`), not through the
  default route. Without that, a 4G/5G failover masks the outage and nothing ever fires.
- **The off delay runs inside the device where possible** (Tasmota `Backlog Power off; Delay 300;
  Power on`, or your own cycle URL). If the router reboots or loses power mid-cycle, the device
  still switches back on. With router-side timing it would stay off.
- **`PowerOnState` is watched and fixed** (Tasmota). If the plug is set to stay off when mains
  power returns, an outage during the off window leaves the controlled equipment dead
  indefinitely. Watchplug detects it, shows it, and corrects it.
- **Optional loop protection**: by default it just retries at the configured delay for as long as
  the link is down. Two independent switches change that — spacing out repeated attempts
  (doubling, 20 min, 40, 80…) and a cap of N cycles per rolling 24 hours, which moves the app to a
  `blocked` state. Both off by default.
- **Status stays live while disarmed**, so you can wire everything up and watch it before you let
  it act.

## Installation

From the router, using the latest release — the exact filename is on the releases page, since the
release number tracks the commit count:

```bash
opkg install --force-reinstall https://github.com/Kitround/Watchplug/releases/latest/download/luci-app-watchplug_1.0.1-1_all.ipk
```

Or entirely from the GUI: *LuCI → System → Software → Upload Package…* with the `.ipk`.

The package is architecture `all` (shell + JS only): no SDK, no cross-compilation, it installs on
any OpenWrt target. `/etc/config/watchplug` is declared as a conffile, so reinstalling never wipes
your settings.

The page shows up under **Services → Watchplug**, with four tabs: *General* (status and manual
buttons), *Settings* (monitoring), *Devices* (the controlled device) and *Logs*.

Monitoring is **off by default**: fill in the device details, try the buttons, watch the status —
it stays live while disarmed — then tick "Enable monitoring".

## Settings

Durations always carry a unit — `s`, `m`, `h` or `d`, as in `30s`, `5m`, `1h`, `7d`. The form
rejects a value without one. A bare number in a hand-edited config is still read as seconds, so
older configs keep working.

| Option | Default | Purpose |
|---|---|---|
| `enabled` | `0` | Arms monitoring. Unchecked means the service runs but never acts. |
| `wan_iface` | `wan` | UCI interface to monitor, resolved to a real device for pinging. |
| `targets` | `1.1.1.1 9.9.9.9 8.8.8.8` | ICMP targets. **IP addresses**, never names (a DNS outage is not a link outage). One reply is enough. |
| `down_time` | `20m` | Continuous downtime before cycling the device, and the spacing between retries while it stays down. |
| `backoff` | `0` | Off: fixed retry spacing. On: the delay doubles after each attempt of the same outage. |
| `backoff_max` | `4h` | Only with `backoff=1`. Upper bound for the doubling. |
| `limit_cycles` | `0` | Off: retries as long as the link is down. On: enforces `max_cycles`. |
| `max_cycles` | `3` | Only with `limit_cycles=1`. Cap per rolling 24 hours. Past that: `blocked`. |
| `recovery_grace` | `10m` | Time given to the equipment to come back and the link to recover after a cycle. |
| `boot_delay` | `5m` | No action while router uptime is below this value. |
| `interval` | `1m` | Check interval. |
| `plug.preset` | `tasmota` | `tasmota` or `custom`. |
| `plug.host` | — | Address of the device, also available as `{host}` in custom URLs. |
| `plug.relay` | `Power` | Tasmota only. `Power` for a single-relay device. |
| `plug.user` / `plug.password` | — | Web authentication, if enabled. |
| `plug.off_time` | `30s` | Time in the off state. Capped at 6 min under the Tasmota preset, which is `Delay`'s own ceiling; a custom cycle URL is not limited. |
| `plug.enforce_poweronstate` | `1` | Tasmota only. Forces `PowerOnState 1`. |
| `plug.url_on` / `url_off` | — | `custom` only. Switch-on and switch-off endpoints. |
| `plug.url_cycle` | — | `custom` only. Single call doing off-wait-on on the device side. Strongly preferred over letting the router hold the timer. |
| `plug.url_state` / `state_key` | — | `custom` only. Polled for display; `state_key` picks a JSON key out of the reply. |

## States

| State | Meaning |
|---|---|
| `ok` | The monitored link answers. |
| `degraded` | Failures in progress, threshold not reached yet. |
| `cooldown` | Cycle done, waiting for the equipment and the link to come back. |
| `blocked` | 24h cap reached, only reachable with `limit_cycles=1`. No further action until the link returns or you rearm. |
| `disabled` | `enabled = 0`. Status keeps updating, nothing is ever switched. |

## CLI

All the logic lives in `/usr/sbin/watchplug`; the GUI and the daemon only call into it:

```
watchplug check               # one immediate check, exit 0 means online
watchplug status              # last known state, JSON
watchplug logs [n]            # last n activity lines (default 200)
watchplug clear-logs          # empty the activity log
watchplug power on|off
watchplug cycle               # manual power cycle
watchplug rearm               # clear the cycle history, unblocking the 24h cap
watchplug fix-poweronstate
watchplug selftest            # threshold / backoff / encoding helpers
```

## Logs

The *Logs* tab shows one line per check — which target answered on which device, how long the link
has been down, how long until the next cycle, the device state — plus every command sent to the
device with its reply, and every state change:

```
[check] 1.1.1.1 replied via pppoe-wan | device 192.0.2.10=ON -> state ok
[warn ] connection lost on pppoe-wan
[check] no reply from 1.1.1.1,9.9.9.9 via pppoe-wan (2x3s each) | offline for 12m30s | cycling in 7m30s | device 192.0.2.10=ON -> state degraded
[warn ] power-cycling 192.0.2.10 (tasmota preset, 30s off)
[http ] http://192.0.2.10:80/cm?user=admin&password=***&cmnd=Backlog%20Power%20off%3B%20Delay%20300%3B%20Power%20on -> {"Backlog":"Done"}
[info ] connection restored after 21m4s
```

It lives in `/var/run/watchplug.log`, capped at 400 lines: one line per minute would fill the
router's 64 KB syslog ring buffer in half a day and evict everything else, so only notable events
are mirrored to `logread -e watchplug`. Device passwords are stripped from logged URLs — both the
`password=` parameter and the configured value itself wherever it lands, since a custom URL can
carry it under any name or in `http://user:pass@host/`. Device replies are truncated in the log,
so a chatty device cannot fill the router's RAM.

*Clear log* empties it. The *Reset* button at the bottom of the page is LuCI's own — it reverts
unsaved changes in the settings form and has nothing to do with the log.

## Device prerequisites

- A static address (DHCP reservation) reachable from the router — including across VLANs or a
  separate home-automation SSID.
- Plain HTTP, no TLS. If web authentication is on, fill in the username and password.
- Tasmota: `PowerOnState 1`, which Watchplug enforces by default.
- Custom devices: prefer an endpoint that does the whole off-wait-on cycle itself, so the timing
  does not depend on the router staying up.
