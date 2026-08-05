#!/usr/bin/env node
'use strict';

// Exercises the LuCI view without a browser.
//
// main.js is not a module: it ends in `return view.extend(...)` because LuCI wraps
// each view in a function and calls it with the objects its `require` lines name.
// This does the same, with stubs that record what the view builds, so the resulting
// structure and behaviour can be asserted on.
//
// It exists because neither the packaging build nor the daemon tests can see any of
// this. Three regressions reached a release unseen: notification banners that never
// went away, devices rendered indistinguishably, and every device setting made
// unreachable by setting modalonly to false rather than leaving it unset. Each has a
// check here.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;

// Button handlers return promises; the summary has to wait for them.
const pending = [];
function return_(p) { pending.push(p); return p; }

function ok(cond, name) {
	if (cond) { passed++; console.log('ok: ' + name); }
	else { failed++; console.error('FAIL: ' + name); }
}

function eq(actual, expected, name) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { passed++; console.log('ok: ' + name); }
	else { failed++; console.error(`FAIL: ${name}\n      expected ${e}\n      got      ${a}`); }
}

// --- LuCI emulation ---------------------------------------------------------

function makeClass(base, props) {
	function C() { if (this.__init__) this.__init__.apply(this, arguments); }
	C.prototype = Object.create(base ? base.prototype : Object.prototype);
	Object.assign(C.prototype, props || {});
	C.prototype.super = function(name, args) {
		const b = base && base.prototype;
		return (b && typeof b[name] === 'function') ? b[name].apply(this, args || []) : undefined;
	};
	C.extend = function(p) { return makeClass(C, p); };
	return C;
}

function named(cls, n) { cls.__name = n; return cls; }

function makeEnv(opts) {
	opts = opts || {};

	const E = (tag, attr, children) => ({
		tag,
		attr: attr || {},
		children: Array.isArray(children) ? children : (children == null ? [] : [ children ]),
		// LuCI's dom.append turns an array child into text nodes but a bare string
		// into innerHTML. Recorded so the tests can insist on the safe form.
		rawHtml: (typeof children === 'string')
	});

	const notifications = [], timers = [], polls = [], rpcCalls = [], maps = [], optionsSeen = [];

	const ui = {
		addNotification(title, children, ...classes) {
			const n = { title, children, classes, timeout: null, removed: false };
			n.parentNode = { removeChild: () => { n.removed = true; } };
			notifications.push(n);
			return n;
		},
		createHandlerFn: (self, fn) => fn
	};
	if (opts.timedNotifications !== false)
		ui.addTimeLimitedNotification = function(title, children, timeout, ...classes) {
			const n = ui.addNotification(title, children, ...classes);
			n.timeout = timeout;
			return n;
		};

	const L = {
		resolveDefault: (p, d) => Promise.resolve(p).catch(() => d),
		toArray: v => (v == null ? [] : (Array.isArray(v) ? v : [ v ])),
		bind: (fn, self, ...a) => fn.bind(self, ...a)
	};

	const SectionBase = makeClass(null, {
		__init__(map, ...rest) { this.map = map; this.args = rest; this.children = []; },
		option(cls, name, title, desc) {
			const o = {
				__cls: (cls && cls.__name) || 'Option',
				option: name, title, description: desc,
				deps: [], section: this, map: this.map,
				depends(k, v) { this.deps.push([ k, v ]); return this; },
				value(k, v) {
					(this.keylist = this.keylist || []).push(k);
					(this.vallist = this.vallist || []).push(v);
					return this;
				}
			};
			this.children.push(o);
			optionsSeen.push(o);
			return o;
		},
		tab(name, title) { (this.tabs = this.tabs || []).push([ name, title ]); },
		taboption(tab, cls, name, title, desc) { return this.option(cls, name, title, desc); },
		render() { return E('div', { 'class': 'cbi-section' }, []); }
	});

	const form = {
		Map: makeClass(null, {
			__init__(config, title, desc) {
				this.config = config; this.title = title; this.description = desc;
				this.sections = [];
				maps.push(this);
			},
			section(cls, ...args) {
				const s = new cls(this, ...args);
				s.__cls = cls.__name || 'Section';
				this.sections.push(s);
				return s;
			},
			lookupOption(name, sid) {
				for (const s of this.sections)
					for (const o of (s.children || []))
						if (o.option === name) return [ o, sid ];
				return null;
			},
			render() { return E('div', { 'class': 'cbi-map' }, this.sections.map(s => s.render())); }
		}),
		NamedSection: named(SectionBase.extend({}), 'NamedSection'),
		TypedSection: named(SectionBase.extend({}), 'TypedSection'),
		GridSection: named(SectionBase.extend({}), 'GridSection'),
		Value: named(function Value() {}, 'Value'),
		Flag: named(function Flag() {}, 'Flag'),
		ListValue: named(function ListValue() {}, 'ListValue'),
		DynamicList: named(function DynamicList() {}, 'DynamicList')
	};

	const rpc = {
		declare(spec) {
			rpcCalls.push(spec);
			const fn = (...args) => Promise.resolve(
				opts.rpcReply ? opts.rpcReply(spec, args) : { ok: true, output: 'done' });
			fn.__spec = spec;
			return fn;
		}
	};

	const uciData = opts.uci || {};
	const uci = { get: (cfg, sid, o) => (uciData[sid] || {})[o] };
	const network = { getHostHints: () => Promise.resolve(opts.hints || { hosts: {} }) };
	const widgets = { NetworkSelect: named(function NetworkSelect() {}, 'NetworkSelect') };
	const poll = { add: (fn, s) => polls.push([ fn, s ]) };

	let viewObj = null;
	const view = { extend(o) { viewObj = o; return o; } };

	return { E, L, ui, form, rpc, uci, network, widgets, poll, view,
	         notifications, timers, polls, rpcCalls, maps, optionsSeen,
	         getView: () => viewObj };
}

function loadView(env) {
	if (!String.prototype.format)
		Object.defineProperty(String.prototype, 'format', {
			value: function (...args) {
				let i = 0;
				return this.replace(/%[sd]/g, m => (m === '%d' ? String(parseInt(args[i++])) : String(args[i++])));
			}
		});
	global.L = env.L;
	global.E = env.E;
	global._ = s => s;
	global.confirm = () => (env.confirmAnswer !== false);
	// The pre-24.10 notification path schedules its own removal through window.
	global.window = { setTimeout: (fn, ms) => { env.timers.push([ fn, ms ]); return env.timers.length; } };

	const file = path.join(__dirname,
		'luci-app-watchplug/htdocs/luci-static/resources/view/watchplug/main.js');
	const src = fs.readFileSync(file, 'utf8');
	const fn = new Function('L', 'E', '_', 'view', 'form', 'rpc', 'poll', 'ui', 'uci',
		'network', 'widgets', src);
	return fn(env.L, env.E, s => s, env.view, env.form, env.rpc, env.poll, env.ui,
		env.uci, env.network, env.widgets);
}

function text(node) {
	if (node == null) return '';
	if (typeof node === 'string') return node;
	if (Array.isArray(node)) return node.map(text).join(' ');
	if (node.children) return node.children.map(text).join(' ');
	return '';
}

function findAll(node, pred, out) {
	out = out || [];
	if (node && typeof node === 'object') {
		if (Array.isArray(node)) node.forEach(n => findAll(n, pred, out));
		else {
			if (pred(node)) out.push(node);
			(node.children || []).forEach(n => findAll(n, pred, out));
		}
	}
	return out;
}

const byId = (tree, id) => findAll(tree, n => n.attr && n.attr.id === id)[0] || null;

const STATUS = {
	state: 'degraded', online: false, enabled: 1, interval: 60,
	wan_iface: 'wan', wan_device: 'eth1',
	down_since: 1000, down_for: 300, cooldown_until: 0, threshold: 1200,
	eta: 900, last_check: Math.floor(Date.now() / 1000), last_cycle: 0,
	backoff: 0, limit_cycles: 1, cycles_24h: 1, max_cycles: 3,
	device_mode: 'chain', device_delay: 30, device_count: 2,
	devices: [
		{ section: '@device[0]', name: 'ONT', enabled: 1, configured: true,
		  preset: 'tasmota', host: '192.0.2.10', off_time: 15, power: 'ON',
		  poweronstate: '1', error: '' },
		{ section: '@device[1]', name: 'Modem', enabled: 0, configured: true,
		  preset: 'custom', host: '192.0.2.11', off_time: 30, power: 'OFF',
		  poweronstate: '?', error: '' }
	],
	message: ''
};

function page(opts, status) {
	const env = makeEnv(opts);
	const v = loadView(env);
	const tree = v.render([ status || STATUS, { log: 'a\nb' }, (opts && opts.hints) || null ]);
	env.view_ = v;
	env.tree = tree;
	env.status = byId(tree, 'watchplug-status');
	env.actions = byId(tree, 'watchplug-actions');
	env.devSection = env.maps[0].sections.find(s => s.args && s.args[0] === 'device') || null;
	return env;
}

const button = (env, label) =>
	findAll(env.actions, n => n.tag === 'button' && text(n) === label)[0] || null;

// Handlers run after every synchronous block, so the globals the view reaches for
// have to be pointed back at the env under test before firing one.
function click(env, label) {
	global.window = { setTimeout: (fn, ms) => { env.timers.push([ fn, ms ]); return env.timers.length; } };
	global.confirm = () => (env.confirmAnswer !== false);
	const b = button(env, label);
	if (!b) { failed++; console.error('FAIL: no button labelled ' + label); return Promise.resolve(); }
	return Promise.resolve(b.attr.click());
}

// --- the contract between the daemon and the page ---------------------------

console.log('# the fixture matches what the daemon actually writes');
{
	// A hand-written fixture drifts silently: rename a field in write_state and every
	// check below would keep passing against a shape nothing produces any more. The
	// keys are read back out of the daemon and compared.
	const daemon = fs.readFileSync(path.join(__dirname,
		'luci-app-watchplug/root/usr/sbin/watchplug'), 'utf8');

	const between = (from, to) => {
		const a = daemon.indexOf(from);
		return a < 0 ? '' : daemon.slice(a, daemon.indexOf(to, a));
	};
	const keys = src => [ ...new Set((src.match(/\\?"[a-z0-9_]+\\?":/g) || [])
		.map(k => k.replace(/[\\":]/g, ''))) ].sort();

	const stateKeys = keys(between('cat >"$STATE_FILE.tmp"', '\nEOF'));
	const devKeys = keys(between('devices_json="$devices_json', '}"'));

	eq(Object.keys(STATUS).sort(), stateKeys, 'the status fixture has exactly the daemon\'s keys');
	eq(Object.keys(STATUS.devices[0]).sort(), devKeys, 'the device fixture has exactly the daemon\'s keys');
	ok(stateKeys.includes('devices'), 'the daemon still writes a devices array');
}

// --- the device form --------------------------------------------------------

console.log('# device form: every setting has to stay reachable');
{
	const env = page({});
	ok(typeof env.view_.render === 'function' && typeof env.view_.load === 'function',
		'the view exports load() and render()');
	ok(env.devSection != null, 'a section bound to the uci type "device" is built');
	eq(env.devSection.__cls, 'GridSection', 'devices are listed by a GridSection');
	ok(env.devSection.addremove === true, 'devices can be added and removed');
	ok(env.devSection.anonymous === true, 'device sections are anonymous');

	// LuCI picks table columns with `if (opt.modalonly) continue` and modal contents
	// with `if (o1.modalonly === false) continue`. false therefore means *removed from
	// the Edit dialog*, which is the regression this file exists to catch.
	const inModal = o => o && o.modalonly !== false;
	const inTable = o => o && !o.modalonly;

	const opts = env.devSection.children;
	const byName = Object.fromEntries(opts.map(o => [ o.option, o ]));

	ok(inModal(byName.preset), 'preset is present in the Edit dialog');

	const dependants = opts.filter(o => o.deps.some(d => d[0] === 'preset'));
	ok(dependants.length >= 6, 'preset drives at least six other settings');
	eq(dependants.filter(o => !inModal(o)).map(o => o.option), [],
		'every setting depending on preset is in the dialog');
	eq(dependants.filter(o => !inModal(byName[o.deps[0][0]])).map(o => o.option), [],
		'no dependency names a field the dialog does not contain');

	for (const n of [ 'url_on', 'url_off', 'url_cycle', 'url_state', 'state_key' ])
		ok(inModal(byName[n]), `the custom HTTP setting ${n} is reachable`);

	eq(opts.filter(inTable).map(o => o.option), [ 'name', 'enabled', 'preset', 'host' ],
		'the table shows what tells two devices apart');
	eq(opts.filter(o => !inModal(o) && !inTable(o)).map(o => o.option), [],
		'no setting is hidden from both places');
}

// --- General tab ------------------------------------------------------------

console.log('# General tab: one titled, separated block per device');
{
	const env = page({});
	eq(findAll(env.actions, n => n.tag === 'h4').map(text), [ 'ONT', 'Modem' ],
		'each device gets its own heading');
	eq(findAll(env.actions, n => /border-top/.test(n.attr.style || '')).length, 2,
		'each block is separated by a rule');
	const t = text(env.actions);
	ok(/tasmota/.test(t) && /ON/.test(t), 'the device state sits inside its block');
	ok(/off 15s per cycle/.test(t), 'the off time is shown per device');
	ok(/not cycled automatically/.test(t), 'a device left out of the cycle says so');
	ok(/padding/.test(findAll(env.actions, n => /border-top/.test(n.attr.style || ''))[0].attr.style),
		'the block has padding so buttons do not touch the next rule');
}

console.log('# General tab: a single device is named too');
{
	const st = JSON.parse(JSON.stringify(STATUS));
	st.devices = [ st.devices[0] ];
	const env = page({}, st);
	eq(findAll(env.actions, n => n.tag === 'h4').map(text), [ 'ONT' ],
		'one device is named rather than left implicit');
	eq(findAll(env.actions, n => /border-top/.test(n.attr.style || '')).length, 1,
		'and still separated from the checks above');
}

console.log('# General tab: an unconfigured device is shown without buttons');
{
	const st = JSON.parse(JSON.stringify(STATUS));
	st.devices = [ { section: '@device[0]', name: '', enabled: 1, configured: false,
	                 preset: '', host: '', off_time: 0, power: '?', poweronstate: '?', error: '' } ];
	const env = page({}, st);
	ok(/not configured/.test(text(env.actions)), 'it says so');
	eq(findAll(env.actions, n => n.tag === 'h4').map(text), [ 'Unnamed device' ],
		'an unnamed device still gets a heading');
	const block = findAll(env.actions, n => /border-top/.test(n.attr.style || ''))[0];
	eq(findAll(block, n => n.tag === 'button').length, 0,
		'its block carries no button that would try to drive it');
}

console.log('# General tab: a device rejecting its state query is not called unreachable');
{
	const st = JSON.parse(JSON.stringify(STATUS));
	st.devices[0].error = 'rejected the state query: {WARNING:...}';
	const env = page({}, st);
	const t = text(env.actions);
	ok(/rejected the state query/.test(t), 'the refusal is quoted');
	ok(!/unreachable or state unknown/.test(t), 'and not confused with an unreachable device');
}

console.log('# status table');
{
	const env = page({});
	const t = text(env.status);
	ok(/Connection lost/.test(t), 'the state is named in words');
	ok(/eth1/.test(t), 'the resolved interface device is shown');
	ok(/one after another/.test(t), 'chain mode is spelled out');
	ok(/1 \/ 3/.test(t), 'the 24h count is shown when the cap is on');
	ok(!/off 15s per cycle/.test(t), 'per-device detail is not duplicated here');
}

console.log('# status table: a stale state file is called out');
{
	const st = JSON.parse(JSON.stringify(STATUS));
	st.last_check = 1;
	ok(/is the service running/.test(text(page({}, st).status)),
		'a status that stopped updating warns about the service');
}

console.log('# status table: no devices at all');
{
	const st = JSON.parse(JSON.stringify(STATUS));
	st.devices = [];
	const env = page({}, st);
	ok(/none configured/.test(text(env.status)), 'the table says none are configured');
	eq(findAll(env.actions, n => n.tag === 'h4').length, 0, 'and no device block is drawn');
}

console.log('# nothing driven by data is injected as raw HTML');
{
	// LuCI's dom.append gives an array child text nodes and a bare string innerHTML.
	// Static descriptions legitimately carry markup; anything built from the status
	// reply must not, or a device could put markup on the page through its name.
	const st = JSON.parse(JSON.stringify(STATUS));
	st.devices[0].name = '<img src=x onerror=alert(1)>';
	st.message = '<b>hi</b>';
	const env = page({}, st);
	eq(findAll(env.status, n => n.rawHtml).map(n => n.tag), [],
		'the status table never takes markup from the reply');
	eq(findAll(env.actions, n => n.rawHtml).map(n => n.tag), [],
		'the device blocks never take markup from the reply');
	ok(text(env.actions).includes('<img src=x onerror=alert(1)>'),
		'a device name is shown as the text it is');
}

// --- notifications ----------------------------------------------------------

// --- rpc surface ------------------------------------------------------------

console.log('# rpc');
{
	const env = page({});
	const byMethod = Object.fromEntries(env.rpcCalls.map(c => [ c.method, c ]));
	eq(byMethod.power.params, [ 'state', 'device' ], 'power is scoped to one device');
	eq(byMethod.cycle.params, [ 'device' ], 'cycle is scoped to one device');
	eq(byMethod.fix_poweronstate.params, [ 'device' ], 'fix_poweronstate is scoped to one device');
	ok(byMethod.status && byMethod.logs && byMethod.check, 'the read methods are declared');
	ok(env.rpcCalls.every(c => c.object === 'luci.watchplug'), 'every call targets one ubus object');
	eq(env.polls.length, 1, 'the page refreshes itself');
	eq(env.polls[0][1], 5, 'every five seconds');
}

// --- host hints -------------------------------------------------------------

console.log('# device address picker');
{
	const hints = { hosts: {
		'aa:01': { name: 'tasmota-plug', ipaddrs: [ '192.0.2.10' ] },
		'aa:02': { ipv4: [ '192.0.2.20' ] },
		'aa:03': { ipaddrs: [ '192.0.2.10' ] }
	} };
	const env = page({ hints });
	const host = env.devSection.children.find(o => o.option === 'host');
	ok(host.keylist.includes('192.0.2.10'), 'a lease with a name is offered');
	ok(host.keylist.includes('192.0.2.20'), 'the 21.02 ipv4 key is read too');
	eq(host.keylist.filter(k => k === '192.0.2.10').length, 1, 'duplicates are collapsed');
	ok(host.vallist.some(v => /tasmota-plug/.test(v)), 'the hostname labels the entry');
	eq(host.datatype, 'host', 'and anything typed in is still validated as a host');
}

console.log('# device address picker with no leases');
{
	const env = page({ hints: { hosts: {} } });
	const host = env.devSection.children.find(o => o.option === 'host');
	ok(host.keylist === undefined, 'no choices are added, so the field stays a plain text box');
}

// --- duration fields --------------------------------------------------------

console.log('# duration fields');
{
	const env = page({});
	const interval = env.optionsSeen.find(o => o.option === 'interval');
	eq(interval.validate('main', '90'), 'A unit is required: 30s, 5m, 2h or 7d.',
		'a bare number is rejected by the form');
	eq(interval.validate('main', '5m'), true, 'a value with a unit passes');
	eq(interval.validate('main', ''), true, 'an empty field is left alone');

	// The Tasmota Delay ceiling must not shorten a custom cycle URL.
	const off = env.devSection.children.find(o => o.option === 'off_time');
	const preset = env.devSection.children.find(o => o.option === 'preset');
	preset.formvalue = () => 'tasmota';
	eq(off.validate('@device[0]', '10m'), 'Maximum: 6m.', 'Tasmota is capped at its own ceiling');
	preset.formvalue = () => 'custom';
	eq(off.validate('@device[0]', '10m'), true, 'a custom cycle URL is not capped');
}

// Handlers resolve in microtasks, so these run one at a time: creating the next page
// would reinstall the globals a pending handler is about to reach for.
async function handlerTests() {
	console.log('# notifications');
	{
		const env = page({});
		await click(env, 'Switch on');
		{
			eq(env.notifications[0].timeout, 5000, 'a confirmation expires on its own');
			eq(env.notifications[0].classes, [ 'info' ], 'as an info banner');
		}
	}

	console.log('# notifications: a failure stays until dismissed');
	{
		const env = page({ rpcReply: () => ({ ok: false, output: 'device refused' }) });
		await click(env, 'Switch off');
		{
			eq(env.notifications[0].timeout, null, 'a failure does not expire');
			eq(env.notifications[0].classes, [ 'error' ], 'and is an error banner');
		}
	}

	console.log('# notifications on LuCI older than 24.10');
	{
		const env = page({ timedNotifications: false });
		ok(env.ui.addTimeLimitedNotification === undefined, 'the timed API is absent, as before 24.10');
		await click(env, 'Switch on');
		{
			const n = env.notifications[0];
			ok(n && !n.removed, 'the banner is shown');
			eq(env.timers.length, 1, 'a removal is scheduled by hand');
			eq(env.timers[0][1], 5000, 'after the same delay');
			env.timers[0][0]();
			ok(n.removed, 'and the banner comes off the page');
		}
	}

	console.log('# the cycle button asks before cutting power');
	{
		const env = page({});
		env.confirmAnswer = false;
		await click(env, 'Cycle');
		{
			eq(env.notifications.length, 0, 'declining the confirmation does nothing at all');
		}
	}

}

handlerTests().then(() => Promise.all(pending)).then(() => {
	console.log('');
	console.log(`${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
});
