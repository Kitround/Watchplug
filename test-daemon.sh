#!/bin/sh
# Drives the real daemon loop against stubbed uci / ping / uclient-fetch, on any POSIX box.
# Compressed timings: down_time 2s instead of 20min, so the whole run takes ~25s.
set -e

here=$(cd "$(dirname "$0")" && pwd)
BIN=$here/package/files/usr/sbin/watchplug
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
watchplug.plug.host=192.0.2.9
watchplug.plug.port=80
watchplug.plug.relay=Power
watchplug.plug.off_time=1
watchplug.plug.http_timeout=1
watchplug.plug.enforce_poweronstate=1
watchplug.plug.user=admin
watchplug.plug.password=s3cr3tpw
EOF

cat >"$tmp/bin/uci" <<EOF
#!/bin/sh
v=\$(grep "^\$3=" "$CFG" | head -1 | cut -d= -f2-)
[ -n "\$v" ] || exit 1
echo "\$v"
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

# backoff is off, so the second attempt must come one down_time later, not two
set -- $(grep Backlog "$FETCHLOG" | cut -d' ' -f1)
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

echo "# custom preset: placeholders expanded, password never logged"
cat >"$tmp/bin/uclient-fetch" <<EOF
#!/bin/sh
for a in "\$@"; do url=\$a; done
echo "\$(date +%s) \$url" >>"$FETCHLOG"
echo OK
EOF
chmod +x "$tmp/bin/uclient-fetch"
cat >>"$CFG" <<'EOF'
watchplug.plug.preset=custom
watchplug.plug.url_cycle=http://{host}:{port}/relay?off={off_time}&ds={off_ds}&pw={password}
EOF
"$BIN" cycle >/dev/null || { echo "FAIL: custom cycle URL reported failure" >&2; exit 1; }
grep -q 'relay?off=1&ds=10&pw=s3cr3tpw' "$FETCHLOG" || {
	echo "FAIL: placeholders not expanded" >&2; grep relay "$FETCHLOG" >&2; exit 1; }
grep -q 's3cr3tpw' "$LOG" && {
	echo "FAIL: custom URL password leaked into the activity log" >&2; tail -3 "$LOG" >&2; exit 1; }
grep -q 'pw=\*\*\*' "$LOG" || {
	echo "FAIL: custom URL not masked in the activity log" >&2; tail -3 "$LOG" >&2; exit 1; }
echo "ok: custom preset expanded, password masked outside a 'password=' parameter"

echo "# clearing the log empties it and says so"
"$BIN" clear-logs >/dev/null
[ "$(grep -c . "$LOG")" -eq 1 ] || {
	echo "FAIL: log not emptied, $(grep -c . "$LOG") lines left" >&2; exit 1; }
grep -q 'activity log cleared' "$LOG" || { echo "FAIL: clearing not recorded" >&2; exit 1; }
echo "ok: log cleared"

echo "test-daemon OK"
