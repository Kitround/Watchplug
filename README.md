# Watchplug

A LuCI app for OpenWrt that drives an **HTTP-controlled device** from the connectivity state of a
**router interface**.

The obvious use is rebooting an upstream modem through a smart plug when the WAN dies, which is
the escalation layer above `watchcat`: watchcat restarts the interface, Watchplug restarts the
hardware when that is not enough. Nothing in the app is tied to that scenario — any interface,
any HTTP device.

## Compatibility

Two packages are published, built with the official OpenWrt SDK. Take the one matching your
release:

| Your OpenWrt | Download |
|---|---|
| 21.02, 22.03, 23.05, 24.10 | `luci-app-watchplug_openwrt-21.02-24.10_all.ipk` |
| 25.12 and later | `luci-app-watchplug_openwrt-25.12_all.apk` |

One file covers the whole opkg range because the app is architecture `all` — pure shell and
JavaScript, no ABI, no versioned dependency — and the `.ipk` container did not change across those
releases. 25.12 is separate because it replaced opkg with apk, a different format entirely.

It needs only `luci-base` and `jshn`, both on a stock image, and installs on any target from an
ath79 router to x86.

Below 21.02 it will not work at all: the UI is built on the client-side LuCI JS API, and an older
LuCI renders its pages server-side.

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
- **Several devices**, each with its own address, credentials and off time. Cycle them together or
  one after another with a wait between — an ONT that has to be back before the router is cut.
  Any of them can be left out of the automatic cycle without being deleted, and each keeps its own
  buttons.
- **Status stays live while disarmed**, so you can wire everything up and watch it before you let
  it act.

## Installation

### From LuCI, no SSH needed

1. Check your release on the LuCI overview page, or with `grep RELEASE /etc/openwrt_release`.
2. On the [releases page](https://github.com/Kitround/Watchplug/releases/latest), under **Assets**,
   download the file for your release from the table above. Save it on the machine your browser
   runs on, not on the router.
3. In LuCI, open **System → Software**.
4. Click **Upload Package…**, pick the file, and confirm.
5. A dialog shows the package name and size. Click **Install**.
6. Reload the page. Watchplug appears under **Services → Watchplug**.

If the menu entry does not show up, force-refresh the browser (`Ctrl`/`Cmd` + `Shift` + `R`) or log
out and back in: LuCI caches its menu, and the install clears that cache server-side only.

Uploading a version already installed does nothing — it is reported as up to date. Putting that
same version back, after a botched upgrade say, needs `--force-reinstall`, which the GUI does not
pass, so use the shell instead. Installing a *newer* version over an older one works from the GUI.

### From the router's shell

Download the asset matching your release from the [releases page](https://github.com/Kitround/Watchplug/releases/latest),
copy it to the router with `scp`, then:

```bash
opkg install --force-reinstall /tmp/luci-app-watchplug_openwrt-21.02-24.10_all.ipk
```

On 25.12 and later, where apk replaced opkg:

```bash
apk add --allow-untrusted /tmp/luci-app-watchplug_openwrt-25.12_all.apk
```

### Either way

`/etc/config/watchplug` is declared as a conffile, so reinstalling or upgrading never wipes your
settings — an upgrade keeps whatever an older release wrote.

The page shows up under **Services → Watchplug**, with four tabs: *General* (status and manual
buttons), *Settings* (monitoring), *Devices* (the controlled devices) and *Logs*.

Monitoring is **off by default**: add your devices, try the buttons, watch the status —
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
| `device_mode` | `parallel` | With several devices: `parallel` cycles them together, `chain` one after another. |
| `device_delay` | `30s` | Only with `device_mode=chain`. Wait between two devices in the chain. |
| `boot_delay` | `5m` | No action while router uptime is below this value. |
| `interval` | `1m` | Check interval. |
| `device.enabled` | `1` | `0` leaves the device out of the automatic cycle without deleting it. |
| `device.name` | — | Shown on the status page, its buttons and the log. |
| `device.preset` | `tasmota` | `tasmota` or `custom`. |
| `device.host` | — | Address of the device, also available as `{host}` in custom URLs. |
| `device.relay` | `Power` | Tasmota only. `Power` for a single-relay device. |
| `device.user` / `device.password` | — | Web authentication, if enabled. |
| `device.off_time` | `30s` | Time in the off state. Capped at 6 min under the Tasmota preset, which is `Delay`'s own ceiling; a custom cycle URL is not limited. |
| `device.enforce_poweronstate` | `1` | Tasmota only. Forces `PowerOnState 1`. |
| `device.url_on` / `url_off` | — | `custom` only. Switch-on and switch-off endpoints. |
| `device.url_cycle` | — | `custom` only. Single call doing off-wait-on on the device side. Strongly preferred over letting the router hold the timer. |
| `device.url_state` / `state_key` | — | `custom` only. Polled for display; `state_key` picks a JSON key out of the reply. |

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
watchplug devices             # list the configured devices and their uci sections
watchplug power on|off [dev]  # one device, or every configured one
watchplug cycle [dev]         # manual power cycle
watchplug rearm               # clear the cycle history, unblocking the 24h cap
watchplug fix-poweronstate [dev]
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
