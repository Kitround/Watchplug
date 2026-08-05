# Watchplug

A LuCI app for OpenWrt that drives an **HTTP-controlled device** from the connectivity state of a
**router interface**.

The obvious use is rebooting an upstream modem through a smart plug when the WAN dies — the
escalation layer above `watchcat`, which restarts the interface but not the hardware. Nothing is
tied to that scenario: any interface, any HTTP device.

Three things a cron job and a curl call do not do:

- **Checks go out of the monitored device itself** (`ping -I pppoe-wan …`), not the default route,
  so a 4G failover cannot mask the outage.
- **The off delay runs inside the device** (Tasmota `Backlog`, or your own cycle URL). A router
  reboot mid-cycle cannot leave the equipment off.
- **`PowerOnState` is watched and fixed**, so a mains outage during the off window cannot leave it
  dead indefinitely.

## Compatibility

| Your OpenWrt | Download |
|---|---|
| 21.02 → 24.10 | `luci-app-watchplug_openwrt-21.02-24.10_all.ipk` |
| 25.12 and later | `luci-app-watchplug_openwrt-25.12_all.apk` |

One `.ipk` covers the whole opkg range: the app is architecture `all` and that container did not
change. 25.12 replaced opkg with apk, hence a second file. It needs only `luci-base` and `jshn`,
both on a stock image. Below 21.02 it will not work — the UI is client-side LuCI JS.

## Installation

From LuCI, no SSH needed:

1. On the [releases page](https://github.com/Kitround/Watchplug/releases/latest), under **Assets**,
   download the file for your release. Save it on the machine your browser runs on.
2. **System → Software → Upload Package…**, pick the file, **Install**.
3. Reload the page. Watchplug appears under **Services → Watchplug**.

If the menu entry does not appear, force-refresh the browser: LuCI caches its menu client-side.
Uploading a version already installed does nothing; putting the same one back needs
`--force-reinstall`, which the GUI does not pass.

From the router's shell, after copying the file over with `scp`:

```bash
opkg install --force-reinstall /tmp/luci-app-watchplug_openwrt-21.02-24.10_all.ipk
```

```bash
apk add --allow-untrusted /tmp/luci-app-watchplug_openwrt-25.12_all.apk
```

`/etc/config/watchplug` is a conffile, so upgrading never wipes your settings. Monitoring is **off
by default**: add your devices, try the buttons, watch the status — it stays live while disarmed —
then tick *Enable monitoring*.

## Devices

Add as many as needed on the *Devices* tab. Each carries its own address, credentials, type and off
time, plus a name that labels it on the status page, its buttons and the log.

- **Tasmota** (built-in): address, relay, optional credentials.
- **Any HTTP API**: switch-on / switch-off / cycle / state URLs, with
  `{host} {port} {user} {password} {off_time} {off_ds}` placeholders. Shelly native, relay boards, a
  home-automation hub, your own CGI script. Prefer an endpoint doing the whole off-wait-on cycle
  itself, so timing does not depend on the router staying up.

The address field offers the hosts the router already knows and still accepts anything typed in,
which is what a plug on a static address needs. Give it a reservation and plain HTTP; there is no
TLS.

With more than one device, *Settings → With several devices* decides what an outage does:
`parallel` cycles them together, `chain` one after another `device_delay` apart — for an ONT that
has to be back before the router is cut. Any device can be left out of the automatic cycle without
being deleted, and one that is unreachable does not cancel the others. The 24 h cap and the
progressive spacing stay global: they count outages, not hardware.

## Settings

Durations carry a unit — `30s`, `5m`, `1h`, `7d`. A bare number in a hand-edited config is still
read as seconds.

| Option | Default | Purpose |
|---|---|---|
| `enabled` | `0` | Arms monitoring. Unchecked, the service runs but never acts. |
| `wan_iface` | `wan` | UCI interface to monitor, resolved to a real device for pinging. |
| `targets` | `1.1.1.1 9.9.9.9 8.8.8.8` | ICMP targets. **IP addresses**, never names. One reply is enough. |
| `down_time` | `20m` | Downtime before cycling, and the spacing between retries. |
| `backoff` / `backoff_max` | `0` / `4h` | On: the delay doubles after each attempt, up to the bound. |
| `limit_cycles` / `max_cycles` | `0` / `3` | On: caps cycles per rolling 24 h, then `blocked`. |
| `recovery_grace` | `10m` | Time given to the equipment and the link to recover after a cycle. |
| `device_mode` / `device_delay` | `parallel` / `30s` | `chain` cycles devices one after another, that far apart. |
| `boot_delay` | `5m` | No action while router uptime is below this. |
| `interval` | `1m` | Check interval. |
| `device.enabled` | `1` | `0` leaves the device out of the automatic cycle without deleting it. |
| `device.name` | — | Shown on the status page, its buttons and the log. |
| `device.preset` | `tasmota` | `tasmota` or `custom`. |
| `device.host` | — | Device address, also `{host}` in custom URLs. |
| `device.relay` | `Power` | Tasmota only. |
| `device.user` / `password` | — | Web authentication, if enabled. |
| `device.off_time` | `30s` | Time in the off state. Capped at 6 min under Tasmota, `Delay`'s own ceiling. |
| `device.enforce_poweronstate` | `1` | Tasmota only. Forces `PowerOnState 1`. |
| `device.url_on` / `url_off` / `url_cycle` | — | `custom` only. `url_cycle` does off-wait-on device-side. |
| `device.url_state` / `state_key` | — | `custom` only. Polled for display; `state_key` picks a JSON key. |

## States

| State | Meaning |
|---|---|
| `ok` | The monitored link answers. |
| `degraded` | Failures in progress, threshold not reached yet. |
| `cooldown` | Cycle done, waiting for the equipment and the link to come back. |
| `blocked` | 24 h cap reached. Nothing further until the link returns or you rearm. |
| `disabled` | `enabled = 0`. Status keeps updating, nothing is ever switched. |

## CLI

All the logic lives in `/usr/sbin/watchplug`; the GUI and the daemon only call into it.

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
watchplug selftest            # duration / threshold / encoding helpers
```

## Logs

The *Logs* tab shows one line per check, every command sent with its reply, and every state change:

```
[check] 1.1.1.1 replied via pppoe-wan | ONT=ON -> state ok
[warn ] connection lost on pppoe-wan
[warn ] power-cycling ONT (tasmota preset, 30s off)
[http ] http://192.0.2.10:80/cm?user=admin&password=***&cmnd=Backlog%20Power%20off%3B... -> {"Backlog":"Done"}
[info ] connection restored after 21m4s
```

It lives in `/var/run/watchplug.log`, capped at 400 lines — one line per minute would fill the
router's 64 KB syslog buffer in half a day, so only notable events reach `logread -e watchplug`.

## Security

- **Device passwords never reach the log.** The `password=` parameter and the configured value
  itself are struck out, raw and percent-encoded — a custom URL can carry it under any name, or in
  `http://user:pass@host/`. Device replies are truncated, so a chatty device cannot fill the RAM.
- **The log and state file are `0600`**, root only. LuCI reads them through rpcd, also root.
- **Ping targets are filtered** before reaching `ping`: a hand-edited `-f` would otherwise run a
  flood ping as root. The ubus device argument is validated against a section-name shape.
- **The password is plain text in `/etc/config/watchplug`**, as every OpenWrt credential is. LuCI's
  ACL granularity is per config file, so read access to Watchplug is read access to that password —
  as with a wifi key. Use a dedicated password, and prefer a plug on an isolated VLAN.

## Development

The repository is an OpenWrt feed: `luci-app-watchplug/` holds the package, `htdocs/` goes to
`/www` and `root/` to the filesystem.

```bash
sh luci-app-watchplug/root/usr/sbin/watchplug selftest   # pure helpers, any POSIX shell
sh test-daemon.sh                                        # the state machine, stubbed uci/ping/HTTP
node test-ui.js                                          # the LuCI view, loaded the way LuCI does
```

`test-ui.js` matters because the other two cannot see the page: it asserts what the Edit dialog
contains, that every `depends()` names a field in the same form, and that nothing from the daemon's
reply is injected as markup. Its fixture is checked against the daemon's own state keys, so it
cannot drift.

Pushing a `v*` tag publishes a release: CI runs the three suites, builds both packages with the
official OpenWrt SDK, and attaches them.

```bash
git tag v1.3.1 && git push origin v1.3.1
```
