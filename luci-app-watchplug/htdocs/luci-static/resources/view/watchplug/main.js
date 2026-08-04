'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require ui';
'require tools.widgets as widgets';

var callStatus = rpc.declare({ object: 'luci.watchplug', method: 'status' });
var callCheck  = rpc.declare({ object: 'luci.watchplug', method: 'check' });
var callLogs   = rpc.declare({ object: 'luci.watchplug', method: 'logs' });
var callPower  = rpc.declare({ object: 'luci.watchplug', method: 'power', params: [ 'state' ] });
var callCycle  = rpc.declare({ object: 'luci.watchplug', method: 'cycle' });
var callRearm  = rpc.declare({ object: 'luci.watchplug', method: 'rearm' });
var callFixPos = rpc.declare({ object: 'luci.watchplug', method: 'fix_poweronstate' });
var callClrLog = rpc.declare({ object: 'luci.watchplug', method: 'clear_logs' });

// Durations always carry a unit. The daemon still reads a bare number as seconds
// so configs written before this rule keep working, but the form requires one.
var DURATION_HELP = _('Always end with a unit: <b>s</b>, <b>m</b>, <b>h</b> or <b>d</b>. Examples: <b>30s</b>, <b>5m</b>, <b>1h</b>, <b>7d</b>.');

function toSeconds(v) {
	var m = /^(\d+)([smhd])$/.exec(String(v).trim().toLowerCase());
	if (!m)
		return null;
	return parseInt(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 })[m[2]];
}

// max may be a number or a function evaluated at validation time, so a ceiling can
// follow another field -- the off time is capped by Tasmota's Delay, not by custom URLs.
function duration_option(s, name, title, desc, placeholder, max) {
	var o = s.option(form.Value, name, title,
		(desc ? desc + '<br />' : '') + DURATION_HELP);
	o.placeholder = placeholder;
	o.validate = function(section_id, value) {
		if (value == '')
			return true;
		var secs = toSeconds(value);
		if (secs === null)
			return _('A unit is required: 30s, 5m, 2h or 7d.');
		var cap = (typeof max == 'function') ? max.call(this, section_id) : max;
		if (cap && secs > cap)
			return _('Maximum: %s.').format(cap >= 60 ? '%dm'.format(cap / 60) : '%ds'.format(cap));
		return true;
	};
	return o;
}

// A tab holding arbitrary content rather than UCI options. form.Map only wires
// data-tab attributes for real sections, so the pane sets its own.
var PaneSection = form.NamedSection.extend({
	__name__: 'PaneSection',

	__init__: function(map, section_id, tab, title, builder) {
		this.super('__init__', [ map, section_id, 'watchplug', title ]);
		this.tabName = tab;
		this.builder = builder;
	},

	render: function() {
		return E('div', {
			'class': 'cbi-section',
			'data-tab': this.tabName,
			'data-tab-title': this.title
		}, this.builder());
	}
});

function stateInfo(s) {
	switch (s) {
	case 'ok':       return [ _('Online'), '#37a835' ];
	case 'degraded': return [ _('Connection lost'), '#f0ad4e' ];
	case 'cooldown': return [ _('Cycled, waiting for recovery'), '#2196f3' ];
	case 'blocked':  return [ _('Blocked — cycle cap reached'), '#cc3333' ];
	case 'disabled': return [ _('Monitoring disabled'), '#888888' ];
	default:         return [ _('Unknown'), '#888888' ];
	}
}

function duration(s) {
	s = parseInt(s);
	if (isNaN(s) || s < 0)
		return '-';
	var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
	if (h) return '%dh %02dmin'.format(h, m);
	if (m) return '%dmin %02ds'.format(m, s % 60);
	return '%ds'.format(s);
}

function stamp(ts) {
	ts = parseInt(ts);
	return (ts > 0) ? new Date(ts * 1000).toLocaleString() : '-';
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '40%' }, [ label ]),
		E('td', { 'class': 'td left' }, [ value ])
	]);
}

function warn(text) {
	return E('span', { 'style': 'color:#cc3333;font-weight:bold' }, [ text ]);
}

function renderStatus(st) {
	st = st || {};

	var info = stateInfo(st.state),
	    now = Date.now() / 1000,
	    interval = parseInt(st.interval) || 60,
	    stale = !st.last_check || (now - st.last_check) > Math.max(180, 3 * interval),
	    rows = [];

	rows.push(row(_('State'),
		E('span', { 'style': 'color:%s;font-weight:bold'.format(info[1]) }, [ info[0] ])));

	if (stale)
		rows.push(row(_('Service'), warn(_('no update since %s — is the service running?').format(stamp(st.last_check)))));

	rows.push(row(_('Link'), st.online
		? _('up') : (st.state == 'unknown' ? '-' : _('down'))));

	rows.push(row(_('Monitored interface'), '%s%s'.format(
		st.wan_iface || '?',
		st.wan_device ? ' (%s)'.format(st.wan_device) : ' — ' + _('no active device'))));

	if (st.state == 'degraded' || st.state == 'cooldown' || st.state == 'blocked') {
		rows.push(row(_('Offline for'), duration(st.down_for)));
		if (st.state == 'degraded')
			rows.push(row(_('Cycling device in'), duration(st.eta) +
				(st.backoff == 1 ? ' ' + _('(spacing now %s)').format(duration(st.threshold)) : '')));
		else if (st.state == 'cooldown')
			rows.push(row(_('Grace period ends in'), duration(st.eta)));
	}

	rows.push(row(_('Last check'), stamp(st.last_check)));
	rows.push(row(_('Last cycle'), stamp(st.last_cycle)));

	if (st.limit_cycles == 1)
		rows.push(row(_('Cycles in 24h'), '%d / %d'.format(
			parseInt(st.cycles_24h) || 0, parseInt(st.max_cycles) || 0)));

	// A device that answers but rejects the query is a wrong relay name or wrong
	// credentials — never let that read as "unreachable", which sends people
	// looking at the network instead of at this form.
	if (!st.device)
		rows.push(row(_('Device'), warn(_('not configured'))));
	else if (st.device_error)
		rows.push(row(_('Device'), warn('%s (%s) — %s'.format(
			st.device, st.preset || '?', st.device_error))));
	else
		rows.push(row(_('Device'), '%s (%s) — %s'.format(st.device, st.preset || '?',
			st.device_power && st.device_power != '?'
				? st.device_power
				: _('unreachable or state unknown'))));

	if (st.off_time)
		rows.push(row(_('A cycle switches off for'), '%s %s'.format(duration(st.off_time),
			_('— it comes back on by itself, give it that long before deciding it failed'))));

	if (st.poweronstate && st.poweronstate != '?' && st.poweronstate != '1')
		rows.push(row(_('PowerOnState'), warn(
			_('%s — the device will not switch back on by itself after a mains outage.').format(st.poweronstate))));

	if (st.message)
		rows.push(row(_('Info'), st.message));

	return E('table', { 'class': 'table', 'id': 'watchplug-status' }, rows);
}

function renderLogs(logs) {
	return E('pre', {
		'id': 'watchplug-logs',
		'style': 'max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:.5em'
	}, [ (logs && logs.log) ? logs.log : _('No log entry yet.') ]);
}

function refresh() {
	return Promise.all([
		L.resolveDefault(callStatus(), {}),
		L.resolveDefault(callLogs(), {})
	]).then(function(res) {
		var st = document.getElementById('watchplug-status');
		if (st)
			st.parentNode.replaceChild(renderStatus(res[0]), st);

		// The buttons depend on the status too — the cycle confirmation quotes the
		// off time, and Rearm only shows with the cap on. Rebuilt so they follow a
		// settings change instead of freezing at whatever was loaded with the page.
		var ac = document.getElementById('watchplug-actions');
		if (ac)
			ac.parentNode.replaceChild(renderActions(res[0]), ac);

		var lg = document.getElementById('watchplug-logs');
		if (lg)
			lg.textContent = (res[1] && res[1].log) ? res[1].log : _('No log entry yet.');
	});
}

// Confirmations expire, failures do not: a banner saying the device refused the
// command is the only place that reason is shown, and it must not vanish while the
// user is reading it. LuCI grew addTimeLimitedNotification in 24.10, so on 21.02
// through 23.05 the plain banner is faded out here instead.
var NOTIFY_MS = 5000;

function notify(ok, text) {
	var cls = ok ? 'info' : 'error';

	if (!ok)
		return ui.addNotification(null, E('p', [ text ]), cls);

	if (typeof ui.addTimeLimitedNotification == 'function')
		return ui.addTimeLimitedNotification(null, E('p', [ text ]), NOTIFY_MS, cls);

	var node = ui.addNotification(null, E('p', [ text ]), cls);
	window.setTimeout(function() {
		if (node && node.parentNode)
			node.parentNode.removeChild(node);
	}, NOTIFY_MS);
	return node;
}

function action(label, fn) {
	return fn().then(function(res) {
		var ok = !res || res.ok !== false;
		notify(ok, '%s: %s'.format(label, (res && res.output) ? res.output : (ok ? _('OK') : _('failed'))));
		return refresh();
	}).catch(function(e) {
		notify(false, '%s: %s'.format(label, e));
	});
}

function button(label, style, handler) {
	return E('button', {
		'class': 'cbi-button cbi-button-' + style,
		'style': 'margin-right:.4em',
		'click': ui.createHandlerFn(null, handler)
	}, [ label ]);
}

function renderActions(st) {
	var buttons = [
		button(_('Check now'), 'action', function() {
			return callCheck().then(function(res) {
				notify(!!(res && res.online), res && res.online
					? _('Link OK — %s').format(res.output || '')
					: _('No reply on the monitored interface — %s').format((res && res.output) || ''));
				return refresh();
			});
		}),
		button(_('Switch on'), 'apply', function() {
			return action(_('Switch on'), function() { return callPower('on'); });
		}),
		button(_('Switch off'), 'reset', function() {
			return action(_('Switch off'), function() { return callPower('off'); });
		}),
		button(_('Force off/on cycle'), 'negative', function() {
			var off = (st && st.off_time) ? duration(st.off_time) : _('the configured off time');
			if (!confirm(_('Switch the device off for %s, then back on? Whatever it powers will restart, and the device stays off for that long before returning on its own.').format(off)))
				return Promise.resolve();
			return action(_('Cycle'), callCycle);
		}),
		button(_('Fix PowerOnState'), 'action', function() {
			return action(_('PowerOnState'), callFixPos);
		})
	];

	// Rearm only clears the cycle history, which nothing reads unless the cap is on.
	if (st && st.limit_cycles == 1)
		buttons.push(button(_('Rearm'), 'action', function() {
			return action(_('Rearm'), callRearm);
		}));

	return E('div', { 'id': 'watchplug-actions', 'style': 'margin:.5em 0' }, buttons);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callStatus(), {}),
			L.resolveDefault(callLogs(), {})
		]);
	},

	render: function(data) {
		var st = data[0], logs = data[1], m, s, o;

		m = new form.Map('watchplug', _('Watchplug'),
			_('Watches connectivity on a router interface and drives an HTTP-controlled device when it stays down.'));
		m.tabbed = true;

		m.section(PaneSection, 'main', 'general', _('General'), function() {
			return [ renderStatus(st), renderActions(st) ];
		});

		s = m.section(form.NamedSection, 'main', 'watchplug', _('Settings'));
		s.anonymous = true;

		o = s.option(form.Flag, 'enabled', _('Enable monitoring'),
			_('While unchecked the service keeps reporting status but never acts.'));
		o.rmempty = false;

		o = s.option(widgets.NetworkSelect, 'wan_iface', _('Monitored interface'),
			_('Checks are sent <em>out of this device</em>. That is what detects the outage even once a failover route has taken over.'));
		o.nocreate = true;
		o.rmempty = false;

		o = s.option(form.DynamicList, 'targets', _('Ping targets'),
			_('IP addresses only, never names: a DNS outage must not pass for a link outage. A single reply is enough to consider the link up.'));
		o.datatype = 'ipaddr';
		o.rmempty = false;

		o = duration_option(s, 'down_time', _('Delay before acting'),
			_('Continuous downtime before cycling the device.'), '20m');
		o.rmempty = false;

		o = s.option(form.Flag, 'backoff', _('Space out repeated attempts'),
			_('Off: retries at the delay above, over and over. On: the delay doubles after each attempt of the same outage (20 min, 40, 80…), so a long upstream outage is not retried as often.'));
		o.rmempty = false;

		o = duration_option(s, 'backoff_max', _('Stop doubling at'),
			_('Upper bound for the doubling above. Once reached, attempts keep this spacing.'), '4h');
		o.depends('backoff', '1');

		o = s.option(form.Flag, 'limit_cycles', _('Limit cycles per 24h'),
			_('Off: keeps retrying as long as the link is down. On: stops after the number below and waits for the link to return or for a manual rearm — useful to spare the relay and to avoid cycling all night on an outage you cannot fix.'));
		o.rmempty = false;

		o = s.option(form.Value, 'max_cycles', _('Maximum cycles per 24h'),
			_('Counted over a rolling 24 hours. Past that the app shows "blocked" until the link returns or you press Rearm.'));
		o.datatype = 'range(1,20)';
		o.depends('limit_cycles', '1');

		o = duration_option(s, 'recovery_grace', _('Grace after a cycle'),
			_('Time given to the equipment to come back and the link to recover before monitoring resumes.'), '10m');
		o.optional = true;

		o = duration_option(s, 'boot_delay', _('Delay after boot'),
			_('No action while router uptime is below this value: when mains power returns, everything boots at once.'), '5m');
		o.optional = true;

		o = duration_option(s, 'interval', _('Check interval'),
			_('Time between two checks.'), '1m');
		o.optional = true;

		o = s.option(form.Value, 'ping_count', _('Packets per target'));
		o.datatype = 'range(1,10)';
		o.optional = true;

		o = duration_option(s, 'ping_timeout', _('Ping timeout'), null, '3s', 60);
		o.optional = true;

		s = m.section(form.NamedSection, 'plug', 'plug', _('Devices'),
			_('Any device with an HTTP API: smart plug, relay board, home-automation hub. Give it a static address the router can reach.'));
		s.anonymous = true;

		o = s.option(form.ListValue, 'preset', _('Device type'));
		o.value('tasmota', _('Tasmota (built-in)'));
		o.value('custom', _('Custom HTTP URLs'));
		o.default = 'tasmota';

		o = s.option(form.Value, 'host', _('Device address'),
			_('Used by the Tasmota preset, and available as <code>{host}</code> in custom URLs.'));
		o.datatype = 'host';
		o.placeholder = '192.168.x.x';

		o = s.option(form.Value, 'port', _('HTTP port'));
		o.datatype = 'port';
		o.placeholder = '80';
		o.optional = true;

		o = s.option(form.ListValue, 'relay', _('Relay'),
			_('"Power" for a single-relay device such as the Shelly Plug S.'));
		o.value('Power', 'Power');
		o.value('Power1', 'Power1');
		o.value('Power2', 'Power2');
		o.value('Power3', 'Power3');
		o.value('Power4', 'Power4');
		o.depends('preset', 'tasmota');

		o = s.option(form.Value, 'user', _('Username'), _('Leave empty if web authentication is disabled.'));
		o.optional = true;

		o = s.option(form.Value, 'password', _('Password'));
		o.password = true;
		o.optional = true;

		o = s.option(form.Value, 'url_on', _('Switch-on URL'),
			_('Placeholders: <code>{host} {port} {user} {password} {off_time} {off_ds}</code>. <code>{off_ds}</code> is the off time in tenths of a second.'));
		o.placeholder = 'http://{host}/relay/0?turn=on';
		o.depends('preset', 'custom');

		o = s.option(form.Value, 'url_off', _('Switch-off URL'));
		o.placeholder = 'http://{host}/relay/0?turn=off';
		o.depends('preset', 'custom');

		o = s.option(form.Value, 'url_cycle', _('Cycle URL (recommended)'),
			_('A single call that switches off and back on after the delay, timed <em>by the device</em>. Leave empty to have the router hold the timer instead — but then a router reboot during the window leaves the device off.'));
		o.placeholder = 'http://{host}/relay/0?turn=off&timer={off_time}';
		o.depends('preset', 'custom');

		o = s.option(form.Value, 'url_state', _('State URL'), _('Optional, polled to show the current state.'));
		o.placeholder = 'http://{host}/relay/0';
		o.depends('preset', 'custom');

		o = s.option(form.Value, 'state_key', _('State JSON key'),
			_('Key to read in the state URL reply, e.g. <code>ison</code>. Empty shows the raw reply.'));
		o.depends('preset', 'custom');

		o = duration_option(s, 'off_time', _('Off time'),
			_('How long the device stays off during a cycle, automatic or via the <em>Force off/on cycle</em> button — it switches back on by itself after this. With the Tasmota preset the delay is run <em>by the device</em> (<code>Backlog Power off; Delay …; Power on</code>), so it survives a router reboot mid-cycle — and is capped at 6 min, which is Tasmota\'s own ceiling. A custom cycle URL has no such limit.'),
			'30s', function(section_id) {
				var p = this.map.lookupOption('preset', section_id);
				return (p && p[0] && p[0].formvalue(p[1]) != 'tasmota') ? 0 : 360;
			});
		o.rmempty = false;

		o = duration_option(s, 'http_timeout', _('HTTP timeout'), null, '5s', 60);
		o.optional = true;

		o = s.option(form.Flag, 'enforce_poweronstate', _('Enforce PowerOnState = ON'),
			_('Automatically fixes the device so it powers back up when mains returns. Without this, a mains outage while it is off leaves the controlled equipment dead indefinitely.'));
		o.rmempty = false;
		o.depends('preset', 'tasmota');

		m.section(PaneSection, 'main', 'logs', _('Logs'), function() {
			return [
				E('div', { 'class': 'cbi-section-descr' },
					_('Every check, every command sent to the device and every state change, newest last, refreshed every 5 s. Kept in RAM (last 400 lines) so it cannot flood the system log; notable events also go to <code>logread -e watchplug</code>. The <em>Reset</em> button at the bottom of the page belongs to the settings form and does not touch this log.')),
				E('div', { 'style': 'margin:.5em 0' }, [
					button(_('Clear log'), 'remove', function() {
						return action(_('Clear log'), callClrLog);
					})
				]),
				renderLogs(logs)
			];
		});

		poll.add(refresh, 5);

		return m.render();
	}
});
