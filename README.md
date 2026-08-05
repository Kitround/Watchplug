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

1. On the [releases page](https://github.com/Kitround/luci-app-watchplug/releases/latest), under **Assets**,
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
