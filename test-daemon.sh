#!/bin/sh
# Drives the real daemon loop against stubbed uci / ping / uclient-fetch, on any POSIX box.
# Compressed timings: down_time 2s instead of 20min, so the whole run takes ~25s.
set -e

here=$(cd "$(dirname "$0")" && pwd)
BIN=$here/luci-app-watchplug/root/usr/sbin/watchplug
tmp=${TMPDIR:-/tmp}/watchplug-test.$$
mkdir -p "$tmp/bin"
# rm last on purpose: the trap's final command sets the script's exit status, and a
# "kill" with an already-cleared pid would fail a run that passed
trap '[ -n "$pid" ] && kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM

export WATCHPLUG_RUN=$tmp
export PATH=$tmp/bin:$PATH
CFG=$tmp/uci.conf
NETUP=$tmp/net_up
FETCHLOG=$tmp/fetch.log

cat >"$CFG" <<EOF
watchplug.main.enabled=0
watchplug.main.interval=1
watchplug.main.targets=192.0.2.1
watchplug.main.wan_iface=wan
watchplug.main.ping_count=1
watchplug.main.ping_timeout=1s
watchplug.main.down_time=2s
watchplug.main.boot_delay=0
watchplug.main.recovery_grace=1s
watchplug.main.backoff=0
watchplug.main.backoff_max=8s
watchplug.main.limit_cycles=1
watchplug.main.max_cycles=2
watchplug.@device[0]=device
watchplug.@device[0].name=plugA
watchplug.@device[0].host=192.0.2.9
watchplug.@device[0].port=80
watchplug.@device[0].relay=Power
watchplug.@device[0].off_time=1
watchplug.@device[0].http_timeout=1
watchplug.@device[0].enforce_poweronstate=1
watchplug.@device[0].user=admin
watchplug.@device[0].password=s3cr3tpw
EOF

# Exact key match, not a grep anchor: section names look like @device[0] and the
# brackets would be read as a character class.
cat >"$tmp/bin/uci" <<EOF
#!/bin/sh
awk -F= -v k="\$3" '\$1 == k { sub(/^[^=]*=/, ""); print; found = 1; exit } END { exit !found }' "$CFG"
EOF

cat >"$tmp/bin/ping" <<EOF
#!/bin/sh
[ -f "$NETUP" ]
EOF

cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
case "\$url" in
	*PowerOnState*) echo '{"PowerOnState":1}' ;;
	*Backlog*)      echo '{"Backlog":"Done"}' ;;
	*)              echo '{"POWER":"ON"}' ;;
esac
EOF

cat >"$tmp/bin/logger" <<'EOF'
#!/bin/sh
exit 0
EOF

chmod +x "$tmp/bin"/*

# resolve_wan needs /lib/functions/network.sh, which only exists on OpenWrt; without it the
# daemon reports "down" before ever pinging. ponytail: shadow the resolver rather than fake
# the whole netifd helper -- the ping path stays the one under test.
sed -e 's|^resolve_wan() {$|resolve_wan() { echo test0; return 0; }\nunused_resolve_wan() {|' \
	"$BIN" >"$tmp/watchplug.test"
chmod +x "$tmp/watchplug.test"
BIN=$tmp/watchplug.test

st() { sed -n 's/.*"state": "\([a-z]*\)".*/\1/p' "$tmp/watchplug.json" 2>/dev/null; }

expect() { # expect <timeout> <state>
	i=0
	while [ $i -lt "$1" ]; do
		[ "$(st)" = "$2" ] && { echo "ok: state '$2'"; return 0; }
		sleep 1
		i=$((i + 1))
	done
	echo "FAIL: expected '$2', got '$(st)' after $1 s" >&2
	echo "--- state ---" >&2
	cat "$tmp/watchplug.json" >&2
	exit 1
}

cycles() {
	# grep -c prints 0 *and* exits 1 on no match: "|| true" keeps set -e from
	# aborting the function before the echo, "|| echo 0" would print 0 twice
	n=$(grep -c Backlog "$FETCHLOG" 2>/dev/null || true)
	echo "${n:-0}"
}

set_enabled() {
	sed -e "s/^watchplug.main.enabled=.*/watchplug.main.enabled=$1/" "$CFG" >"$CFG.new"
	mv "$CFG.new" "$CFG"
}

touch "$NETUP"
"$BIN" daemon &
pid=$!

echo "# monitoring disarmed: status must still be live"
expect 6 disabled
grep -q 'cmnd=Power' "$FETCHLOG" || { echo "FAIL: device not polled while disabled" >&2; exit 1; }
grep -q '"wan_device": "test0"' "$tmp/watchplug.json" || {
	echo "FAIL: interface not resolved while disabled" >&2; cat "$tmp/watchplug.json" >&2; exit 1; }
[ "$(cycles)" -eq 0 ] || { echo "FAIL: cycled while disabled" >&2; exit 1; }
echo "ok: device and interface reported while monitoring is off"

set_enabled 1
expect 6 ok

echo "# link goes down"
rm -f "$NETUP"
expect 4 degraded

# saving anything in LuCI fires the config reload trigger, which procd turns into a
# restart: the outage clock has to survive it or the countdown starts over
ds() { sed -n 's/.*"down_since": \([0-9]*\).*/\1/p' "$tmp/watchplug.json"; }
ds_before=$(ds)
kill $pid 2>/dev/null
sleep 1
"$BIN" daemon &
pid=$!
sleep 2
[ -n "$ds_before" ] && [ "$(ds)" = "$ds_before" ] || {
	echo "FAIL: down_since went from '$ds_before' to '$(ds)' across a restart" >&2; exit 1; }
echo "ok: outage clock survived a daemon restart (down_since=$ds_before)"

expect 8 cooldown
[ "$(cycles)" -ge 1 ] || { echo "FAIL: no Backlog sent to the plug" >&2; exit 1; }
echo "ok: power cycle triggered after down_time"

echo "# still down: retries at a fixed spacing, then cap at max_cycles=2"
expect 20 blocked
[ "$(cycles)" -eq 2 ] || { echo "FAIL: $(cycles) cycles instead of 2" >&2; exit 1; }
echo "ok: 24h cap honoured, no further cycle while blocked"

# backoff is off, so the second attempt must come one down_time later, not two.
#
# Measured on the cycle history, not on the fetch log. The daemon stamps a cycle with
# the time the tick started, while the request itself goes out after poll_all and
# check_conn have run -- a gap that grows with how slow the box is. Timing the
# fetches was timing that delay as much as the spacing, and it is what made this
# assertion flaky on CI.
set -- $(cat "$tmp/watchplug.cycles")
gap=$(( $2 - $1 ))
[ "$gap" -ge 2 ] || { echo "FAIL: retries $gap s apart, expected at least down_time=2" >&2; exit 1; }
[ "$gap" -le 4 ] || { echo "FAIL: retries $gap s apart, backoff is disabled so it should stay near 2" >&2; exit 1; }
echo "ok: fixed retry spacing (${gap}s) with backoff disabled"

echo "# rearm clears the cycle history and lets the daemon act again"
before=$(cycles)
"$BIN" rearm >/dev/null
expect 10 cooldown
[ "$(cycles)" -gt "$before" ] || {
	echo "FAIL: still blocked after rearm, $(cycles) cycles" >&2; exit 1; }
grep -q 'rearmed from the web interface' "$tmp/watchplug.log" || {
	echo "FAIL: rearm not recorded in the activity log" >&2; exit 1; }
echo "ok: rearm unblocked monitoring ($before -> $(cycles) cycles)"
after_rearm=$(cycles)

echo "# link comes back"
touch "$NETUP"
expect 6 ok
[ "$(cycles)" -eq "$after_rearm" ] || { echo "FAIL: spurious cycle after the link returned" >&2; exit 1; }

echo "# activity log"
LOG=$tmp/watchplug.log
grep -q '\[check\]' "$LOG" || { echo "FAIL: no check line in the activity log" >&2; exit 1; }
grep -q 'cycling in' "$LOG" || { echo "FAIL: countdown missing from the activity log" >&2; exit 1; }
grep -q 'power-cycling' "$LOG" || { echo "FAIL: cycle not recorded in the activity log" >&2; exit 1; }
grep -q '\[http \].*Backlog' "$LOG" || { echo "FAIL: device command not recorded" >&2; exit 1; }
grep -q 'password=\*\*\*' "$LOG" || { echo "FAIL: masked password never seen, check the http log" >&2; exit 1; }
grep -q 's3cr3tpw' "$LOG" && { echo "FAIL: device password leaked into the activity log" >&2; exit 1; }
echo "ok: activity log complete, credentials masked"

grep -q 'cmnd=Power%20off' "$FETCHLOG" 2>/dev/null && { echo "FAIL: bare off sent outside Backlog" >&2; exit 1; }
grep -q 'Backlog%20Power%20off%3B%20Delay%2010%3B%20Power%20on' "$FETCHLOG" || {
	echo "FAIL: malformed Backlog command" >&2; grep Backlog "$FETCHLOG" >&2; exit 1; }
echo "ok: Backlog command is correct (off time run by the plug)"

echo "# a device that refuses the command must fail loudly, not silently"
kill $pid 2>/dev/null
pid=
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
echo '{"Command":"Unknown"}'
EOF
chmod +x "$tmp/bin/uclient-fetch"
if "$BIN" cycle >/dev/null 2>&1; then
	echo "FAIL: cycle reported success though the device refused the command" >&2
	exit 1
fi
grep -q '\[error\].*refused the cycle command' "$LOG" || {
	echo "FAIL: refusal not explained in the activity log" >&2; tail -3 "$LOG" >&2; exit 1; }
echo "ok: refused command surfaces as an error"

echo "# several devices: cycled together, chained, or left out"
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
case "\$url" in
	*PowerOnState*) echo '{"PowerOnState":1}' ;;
	*Backlog*)      echo '{"Backlog":"Done"}' ;;
	*)              echo '{"POWER":"ON"}' ;;
esac
EOF
chmod +x "$tmp/bin/uclient-fetch"
cat >>"$CFG" <<'EOF'
watchplug.@device[1]=device
watchplug.@device[1].name=plugB
watchplug.@device[1].host=192.0.2.11
watchplug.@device[1].port=80
watchplug.@device[1].relay=Power
watchplug.@device[1].off_time=1
watchplug.@device[1].http_timeout=1
EOF
[ "$("$BIN" devices | wc -l | tr -d ' ')" -eq 2 ] || {
	echo "FAIL: both devices not listed" >&2; "$BIN" devices >&2; exit 1; }

: >"$FETCHLOG"
"$BIN" cycle >/dev/null || { echo "FAIL: cycling two devices failed" >&2; exit 1; }
grep -q '192\.0\.2\.9.*Backlog' "$FETCHLOG" || {
	echo "FAIL: first device not cycled" >&2; cat "$FETCHLOG" >&2; exit 1; }
grep -q '192\.0\.2\.11.*Backlog' "$FETCHLOG" || {
	echo "FAIL: second device not cycled" >&2; cat "$FETCHLOG" >&2; exit 1; }
echo "ok: both devices cycled"

echo "watchplug.@device[1].enabled=0" >>"$CFG"
: >"$FETCHLOG"
"$BIN" cycle >/dev/null || { echo "FAIL: cycle failed with one device disabled" >&2; exit 1; }
grep -q '192\.0\.2\.11.*Backlog' "$FETCHLOG" && {
	echo "FAIL: a disabled device was cycled anyway" >&2; exit 1; }
grep -q '192\.0\.2\.9.*Backlog' "$FETCHLOG" || {
	echo "FAIL: the enabled device was skipped too" >&2; exit 1; }
echo "ok: a disabled device is left alone, the other still cycles"

# grep -Fv, not sed: the key contains brackets
grep -Fv 'watchplug.@device[1].enabled=0' "$CFG" >"$CFG.new" && mv "$CFG.new" "$CFG"
printf 'watchplug.main.device_mode=chain\nwatchplug.main.device_delay=2\n' >>"$CFG"
: >"$FETCHLOG"
t0=$(date +%s)
"$BIN" cycle >/dev/null || { echo "FAIL: chained cycle failed" >&2; exit 1; }
gap=$(( $(date +%s) - t0 ))
[ "$gap" -ge 2 ] || { echo "FAIL: chain mode did not wait between devices (${gap}s)" >&2; exit 1; }
grep -q '192\.0\.2\.11.*Backlog' "$FETCHLOG" || {
	echo "FAIL: chain stopped before the second device" >&2; exit 1; }
echo "ok: chain mode waited ${gap}s before the second device"

grep -Fv 'watchplug.main.device_mode=chain' "$CFG" >"$CFG.new" && mv "$CFG.new" "$CFG"

echo "# custom preset: placeholders expanded, password never logged"
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
echo OK
EOF
chmod +x "$tmp/bin/uclient-fetch"
cat >>"$CFG" <<'EOF'
watchplug.@device[0].preset=custom
watchplug.@device[0].url_cycle=http://{host}:{port}/relay?off={off_time}&ds={off_ds}&pw={password}
EOF
"$BIN" cycle >/dev/null || { echo "FAIL: custom cycle URL reported failure" >&2; exit 1; }
grep -q 'relay?off=1&ds=10&pw=s3cr3tpw' "$FETCHLOG" || {
	echo "FAIL: placeholders not expanded" >&2; grep relay "$FETCHLOG" >&2; exit 1; }
grep -q 's3cr3tpw' "$LOG" && {
	echo "FAIL: custom URL password leaked into the activity log" >&2; tail -3 "$LOG" >&2; exit 1; }
grep -q 'pw=\*\*\*' "$LOG" || {
	echo "FAIL: custom URL not masked in the activity log" >&2; tail -3 "$LOG" >&2; exit 1; }
echo "ok: custom preset expanded, password masked outside a 'password=' parameter"

echo "# a cycle is written down before it is fired, not after"
# A chained cycle runs for as long as device_delay times the device count, and procd
# restarts this daemon on every config change. If the record came after the commands,
# a restart inside that window would lose it and cycle everything again. Proven with a
# slow device rather than by racing a kill: the record must already be there while the
# request is still in flight.
# Own config, one Tasmota device: earlier tests leave a custom-URL device behind, and
# a custom reply cannot be validated, so a refusal there still counts as taken.
cat >"$CFG" <<'EOF'
watchplug.@device[0]=device
watchplug.@device[0].name=plugA
watchplug.@device[0].host=192.0.2.9
watchplug.@device[0].relay=Power
watchplug.@device[0].off_time=1
EOF
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
case "\$url" in *Backlog*) sleep 4 ;; esac
echo '{"Backlog":"Done"}'
EOF
chmod +x "$tmp/bin/uclient-fetch"
rm -f "$tmp/watchplug.cycles"
"$BIN" cycle >/dev/null 2>&1 &
cycle_pid=$!
sleep 2
[ -s "$tmp/watchplug.cycles" ] || {
	echo "FAIL: the cycle was not recorded before the command went out" >&2
	kill $cycle_pid 2>/dev/null; exit 1; }
echo "ok: recorded while the command is still in flight"
kill $cycle_pid 2>/dev/null
wait $cycle_pid 2>/dev/null || true

echo "# a cycle that reached no device is not counted against the cap"
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
echo '{"Command":"Unknown"}'
EOF
chmod +x "$tmp/bin/uclient-fetch"
: >"$tmp/watchplug.cycles"
"$BIN" cycle >/dev/null 2>&1 && { echo "FAIL: a refused cycle reported success" >&2; exit 1; }
[ -s "$tmp/watchplug.cycles" ] && {
	echo "FAIL: a cycle nothing took still counts against the 24h cap" >&2
	cat "$tmp/watchplug.cycles" >&2; exit 1; }
echo "ok: a refused cycle leaves the history untouched"

echo "# a config written before multiple devices is still driven"
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
echo '{"Backlog":"Done"}'
EOF
chmod +x "$tmp/bin/uclient-fetch"
cat >"$CFG" <<'EOF'
watchplug.plug=plug
watchplug.plug.host=192.0.2.50
watchplug.plug.relay=Power
watchplug.plug.off_time=1
EOF
[ "$("$BIN" devices | cut -f1)" = plug ] || {
	echo "FAIL: the legacy plug section is not reported as a device" >&2; "$BIN" devices >&2; exit 1; }
: >"$FETCHLOG"
"$BIN" cycle >/dev/null || { echo "FAIL: a legacy config could not be cycled" >&2; exit 1; }
grep -q '192\.0\.2\.50.*Backlog' "$FETCHLOG" || {
	echo "FAIL: the legacy plug was not cycled" >&2; cat "$FETCHLOG" >&2; exit 1; }
echo "ok: an un-migrated config keeps being driven"

echo "# the uci-defaults migration converts a pre-multi-device config"
# This script ships and runs once on upgrade, and nothing had ever executed it. The
# stub covers the uci verbs it uses, against a flat key=value file.
MIG=$here/luci-app-watchplug/root/etc/uci-defaults/98-watchplug-devices
cat >"$tmp/bin/uci" <<EOF
#!/bin/sh
CFG="$CFG"
case "\$1" in
-q) shift ;;
esac
case "\$1" in
get)
	# exec, so awk's exit status is the stub's: a plain call would be masked by the
	# exit 0 below and every "does this section exist" check would answer yes.
	exec awk -F= -v k="\$2" '\$1 == k { sub(/^[^=]*=/, ""); print; f=1; exit } END { exit !f }' "\$CFG"
	;;
add)
	n=0
	while grep -Fq "watchplug.@\$3[\$n]=" "\$CFG"; do n=\$((n + 1)); done
	echo "watchplug.@\$3[\$n]=\$3" >>"\$CFG"
	echo "@\$3[\$n]"
	;;
set)
	k=\${2%%=*}; v=\${2#*=}
	grep -Fv "\$k=" "\$CFG" >"\$CFG.n"; mv "\$CFG.n" "\$CFG"
	echo "\$k=\$v" >>"\$CFG"
	;;
delete)
	grep -Fv "\$2." "\$CFG" | grep -Fv "\$2=" >"\$CFG.n"; mv "\$CFG.n" "\$CFG"
	;;
commit) : ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/uci"
cat >"$CFG" <<'EOF'
watchplug.main=watchplug
watchplug.plug=plug
watchplug.plug.preset=tasmota
watchplug.plug.host=192.0.2.77
watchplug.plug.relay=Power2
watchplug.plug.password=oldpw
watchplug.plug.off_time=45s
EOF
sh "$MIG" >/dev/null 2>&1
grep -Fq 'watchplug.@device[0]=device' "$CFG" || {
	echo "FAIL: migration created no device section" >&2; cat "$CFG" >&2; exit 1; }
for kv in host=192.0.2.77 relay=Power2 password=oldpw off_time=45s enabled=1; do
	grep -Fq "watchplug.@device[0].${kv}" "$CFG" || {
		echo "FAIL: migration lost $kv" >&2; cat "$CFG" >&2; exit 1; }
done
grep -Fq 'watchplug.plug' "$CFG" && {
	echo "FAIL: the old plug section was left behind" >&2; cat "$CFG" >&2; exit 1; }
echo "ok: settings moved to a device section, old section removed"

before=$(cat "$CFG")
sh "$MIG" >/dev/null 2>&1
[ "$before" = "$(cat "$CFG")" ] || {
	echo "FAIL: running the migration twice changed the config again" >&2; exit 1; }
echo "ok: running it twice is a no-op"

echo "# clearing the log empties it and says so"
"$BIN" clear-logs >/dev/null
[ "$(grep -c . "$LOG")" -eq 1 ] || {
	echo "FAIL: log not emptied, $(grep -c . "$LOG") lines left" >&2; exit 1; }
grep -q 'activity log cleared' "$LOG" || { echo "FAIL: clearing not recorded" >&2; exit 1; }
echo "ok: log cleared"

echo "test-daemon OK"
