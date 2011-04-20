#!/usr/bin/env node
/**
 * Red Lantern
 * By Stendec
 *
 * A proxy server, written with node.js, that allows connections to legacy
 * MUDs with WebSockets, making it easy to create web-based clients.
 *
 * Red Lantern has support for access control, allowing you to block certain IP
 * addresses from connecting and requiring the client to log in with a username
 * and password before allowing a connection to form.
 *
 * Uses some code by other people.
 *
 * Copyright (c) 2010 Stendec
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

// Fancy Stuff
process.title = 'redlantern';
const VERSION = '0.1';

// Make local paths work.
require.paths.unshift(__dirname);
 
// System Module
var sys 	 = require('sys'),
	fs		 = require('fs'),
	path	 = require('path');

// Other Modules
var optparse = require('lib/optparse'),
	iniparse = require('lib/iniparser'),
	Oa		 = require('lib/oa').Oa;

// Okay. First, parse our options.
var switches = [
	['-p','--port NUMBER','Listen on the specified port.'],
	['-i','--ip IP','Bind the server to IP.'],
	['-m','--max-connections NUMBER','Accept up to the specified number of connections at a time.'],
	['-h','--help','Shows this help.']
];

var parser = new optparse.OptionParser(switches),
	options = {
		port: undefined,
		ip:   undefined,
		con:  undefined
	},
	config_file = undefined;
parser.banner = 'Usage: redlantern.js [options] configuration_file';

parser.on('port', function(rule,val) { options.port = val; });
parser.on('ip', function(rule,val) { options.ip = val; });
parser.on('max-connections', function(rule,val) {
	val = parseInt(val);
	if ( val <= 0 ) { val = null; }
	options.con = val;
});
parser.on('help', function() {
	sys.puts(parser.toString());
	process.exit(0);
});
parser.on(0, function(val) { config_file = val; });

// Parse our arguments.
try {
	parser.parse(process.ARGV.slice(2));
} catch(err) {
	sys.puts('Error parsing arguments: ' + err.msg);
	process.exit(1);
}

// Do we have a configuration file?
if ( !config_file ) {
	sys.puts('You must specify a configuration file!');
	process.exit(1); }

// Try parsing the INI file.
config_file = path.normalize(config_file);
var stat;
try { stat = fs.statSync(config_file);
} catch(err) { }
if ( !stat || !stat.isFile() ) {
	sys.puts('Cannot find configuration file: ' + config_file);
	process.exit(1); }

// Get configuration.
iniparse.parse(config_file, function(data) {
	finalStart(data);
});

// Delete some boring stuff so it's GCed quickly.
delete config_file;
delete parser;
delete optparse;
delete iniparse;
delete switches;

function finalStart(data) {
	// Now that we have our data, build our configuration to invoke Oa.
	if ( data.general === undefined ) { data.general = {}; }
	if ( options.port && options.port > 0 && options.port < 65535 ) {
		data.general.port = options.port;
	} else if (typeof options.port === 'string') {
		data.general.port = parseInt(data.general.port); }
	if ( options.con !== undefined ) {
		data.general.connections = options.con == null ? undefined : options.con; }
	if ( options.ip ) { data.general.ip = options.ip; }
	
	// Process hosts and users.
	data.hosts = {};
	data.users = {};
	var nh=0,nu=0;
	for(var k in data) {
		if (typeof k !== 'string') { continue; }
		if (k.substr(0,5) === 'host:') {
			var host = data[k];
			if ( host.compress ) { delete host.compress; }
			if ( host.port ) { host.port = parseInt(host.port); }
			if ( host.groups ) {
				var d = host.groups.split(',');
				host.groups = [];
				while (d.length>0) {
					var gr = d.shift();
					host.groups.push(gr.trim());
				}
			}
			if ( host.users ) {
				var d = host.users.split(',');
				host.users = [];
				while (d.length>0) {
					var gr = d.shift();
					host.users.push(gr.trim());
				}
			}
			data.hosts[k.substr(5)] = host;
			nh++;
			delete data[k];
		} else if ( k.substr(0,5) === 'user:') {
			data.users[k.substr(5)] = data[k];
			nu++;
			delete data[k];
		}
	}
	
	data.general.hosts = nh;
	data.general.users = nu;
	
	if ( data.general.blacklist ) {
		data.blacklist = data.general.blacklist.split(',');
	} else {
		data.blacklist = [];
	}
	
	// Setup some ugly error catching.
	process.on('uncaughtException', function (err) {
		sys.log('Caught exception: ' + sys.inspect(err));
	});
	
	// Initialize Oa.
	sys.log('Red Lantern v'+VERSION);
	new Oa(data,VERSION).start();
}