/**
 * Red Lantern
 * By Stendec
 *
 * The Core - Oa
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

// System Requirements
var sys = require('sys'),
	net = require('net'),
	crypto = require('crypto'),
	fs = require('fs'),
	tls = require('tls');

// Other Requirements
var menu = require('./menu');
	
// Constants
const MANDATORY_HEADERS = {
	Upgrade:	'WebSocket',
	Connection:	'Upgrade',
	Host:		null,
	Origin:		null
};
	
/** Construct a new Oa core.
 * @param {Object} data The configuration dict.
 */
var Oa = function Oa(data,ver) {
	this.version = ver;
	this.data = data;
	
	// Log that we've started.
	sys.log('Oa - Initializing...');
	
	var oa = this;
	if(data.general.ssl_cert !== undefined &&
		data.general.ssl_key !== undefined &&
		data.general.ssl_ca !== undefined) {
		sys.log('Oa - TLS enabled.');
		var tls_options = {
			key: fs.readFileSync(data.general.ssl_key),
			cert: fs.readFileSync(data.general.ssl_cert),
			ca: fs.readFileSync(data.general.ssl_ca)
		};
		this.server = tls.createServer(tls_options,function(stream,enc_stream){oa.newStream(stream);});
        } else {
		this.server = net.createServer(function(stream){oa.newStream(stream);});
        }
};
Oa.stream_id = 0;
Oa.connections = 0;

/** Set up a new stream. */
Oa.prototype.newStream = function(stream) {
	if ( this.data.blacklist.indexOf(stream.remoteAddress) !== -1 ) {
		sys.log('Oa - Blocked connection from '+stream.remoteAddress);
		stream.destroy();
		return;
	}
	
	// Make an ID for teh stream.
	stream.id = ( ++Oa.stream_id );
	
	// Increment the connections counter.
	Oa.connections++;
	stream.counted = true;
	
	// Log the new connection.
	sys.log('St.' + stream.id + ' - New connection from '+stream.remoteAddress);
	
	// Connect some events.
	stream.on('data', onData);
	stream.on('end',  onEnd);
	stream.on('close', onClose);
	
	// Speed stuff up.
	stream.setNoDelay(true);
	
	// Bind message
	stream.message = message.bind(stream);
	stream.connectTo = connectTo.bind(stream);
	
	// Store Oa in the stream, as well as state information.
	stream.Oa = this;
	stream.state = 0;
	stream.state_ws = false;
	stream.expect_frame = true;
	stream.buf = '';
	
	// Set a timeout to bust the menu.
	stream.timer = setTimeout(initialTimeout.bind(stream),2000);
};

var initialTimeout = function() {
	clearTimeout(this.timer);
	
	// Still here? Create a menu.
	if ( !this.proxied && this.state === 0 ) {
		new menu.Telnet(this);
		this.state = 1;
	} else {
		sys.puts(sys.inspect(this));
	}
}

/** Called when a socket's closed. Make sure its proxied is destroyed. */
var onClose = function onClose() {
	try {
		if ( this.proxied ) {
			this.proxied.destroy();
			delete this.proxied; }
	} catch(err) { }
	
	if ( this.counted ) {
		this.counted = false;
		Oa.connections--;
	}
}

/** Called when a socket disconnects. */
var onEnd = function onEnd() {
	clearTimeout(this.timer);
	
	// Do we have a proxied connection? If so, close it.
	if ( this.proxied ) {
		this.proxied.destroy();
		delete this.proxied; }
	
	// Just end now.
	this.end();
	
	if ( this.counted ) {
		this.counted = false;
		Oa.connections--;
	}
}

/** Called when the socket receieves data. */
var onData = function onData(data) {
	clearTimeout(this.timer);
	
	if ( this.state_ws ) {
		readWebSocket.call(this, data);
	} else {
		if ( this.proxied ) {
			this.proxied.write(data);
			return; }
		
		if ( this.state === 0 ) {
			readInitial.call(this, data);
		} else if ( this.state === 1 ) {
			this.telnet.read(data.toString('binary'));
		}
	}
}

/** Handle the initial choice bit. */
var readInitial = function(data) {
	// Guess we don't. In that case, convert the data to a binary string to try
	// determining what we should be doing.
	this.buf += data.toString('binary');
	
	// Check Policy File Request.
	if ( this.buf === '<policy-file-request/>\x00' ) {
		sys.log('St.' + this.id + ' - Policy File Request');
		this.Oa.sendPolicyFileRequest(this);
		this.destroy();
	}
	
	// Check WebSocket Header
	else if ( this.buf.substr(0,4) === 'GET ' && this.buf.indexOf('\r\n\r\n') !== -1 ) {
		parseHeader(this);
		this.buf = '';
	}
	
	// Is it something else?
	else if ( this.buf.length > 3 && !(this.buf.substr(0,4) === 'GET ') ) {
		// Show the menu.
		new menu.Telnet(this);
		this.state = 1;
	}
}

/** Send a policy file to a stream. */
Oa.prototype._fpd = undefined;
Oa.prototype.sendPolicyFileRequest = function(stream) {
	if ( this._fpd ) {
		stream.write(this._fpd);
		return; }
	
	var fpd = '<?xml version="1.0"?>';
	fpd +=  '\n<!DOCTYPE cross-domain-policy SYSTEM "/xml/dtds/cross-domain-policy.dtd">';
	fpd +=  '\n<cross-domain-policy>';
	var ports = [this.data.general.port];
	for(var k in this.data.hosts) {
		var h = this.data.hosts[k];
		if ( h.host !== 'localhost' && h.host !== '127.0.0.1' ) { continue; }
		if ( h.port && ports.indexOf(h.port) === -1 ) {
			ports.push(h.port); }
	}
	ports.sort();
	fpd +=  '\n\t<allow-access-from domain="*" to-ports="'+ports.join(',')+'" />';
	fpd +=  '\n</cross-domain-policy>';
	
	// Store that FPD and send it.
	this._fpd = new Buffer(fpd,'ascii');
	stream.write(this._fpd);
}

var c = function(col) {
	if ( col === null ) { return '\x1B[0m'; }
	return '\x1B[38;5;'+col+'m'; }
var p = function() {
	var out = '';
	for(var i=0,l=arguments.length;i<l;i++) {
		if (typeof arguments[i] === 'string') { out += arguments[i]; }
		else { out += c(arguments[i]); }
	}
	return out; }

/** Send a banner with the number of connected users to the client. */
Oa.prototype.sendBanner = function(stream) {
	var out = p('\x1B[H\x1B[J',9,'Red Lantern MUD Proxy ',8,'(',7,
		'v'+this.version,8,') for ',7,'DecafMUD',8,' by ',7,'Stendec',null,'\r\n\r\n',88);
	
	out += '    With node.js in old MUDs stead, encoding text for sockets Web,\n';
	out += '    The rhymes are bad, but proxy great, now play some MUD for Hassan\'s sake!\r\n\r\n';
	
	var cn = Oa.connections;
	if ( cn < 2 ) {
		out += p(null,'  There is currently ',9,'1',null,' user connected.');
	} else {
		out += p(null,'  There are currently ',9,cn.toString(),null,' users connected.');
	}
	
	stream.message(out+'\r\n\r\n');
}

Oa.prototype.start = function() {
	var msg = 'Oa - Listening';
	if ( this.data.general.ip ) {
		msg += ' at ' + this.data.general.ip; }
	msg += ' on port ' + this.data.general.port;
	
	// Set the max connections for safety and print out some configuration bits.
	sys.puts(new Array(80).join('-'));
	if ( this.data.general.connections !== undefined ) {
		this.server.maxConnections = this.data.general.connections;
		sys.log('Maximum connections: ' + this.server.maxConnections);
	} else {
		sys.log('Maximum connections: Unlimited'); }
	sys.log('  Available Servers: ' + this.data.general.hosts);
	sys.log('   Registered Users: ' + this.data.general.users);
	sys.puts(new Array(80).join('-'));
	this.server.listen(this.data.general.port, this.data.general.ip);
	sys.log(msg);
}

/** Check to see if a specific Origin is allowed to connect. */
Oa.prototype.checkOrigin = function(origin) {
	if ( !this.data.origins ) { return true; }
	for(var i=0,l=this.data.origins.length;i<l;i++) {
		// Hallowed are the Ori.
		var ori = this.data.origins[i];
		if (ori === origin) {
			return true; }
	}
	return false;
}

/** Check to see if a user is valid. */
Oa.prototype.checkUser = function(username, password) {
	var user = this.data.users[username];
	if ( user !== undefined ) {
		password = crypto.createHash('sha1').update(password).digest('hex');
		if (user.password === password) {
			user.username = username;
			return user;
		}
	}
	
	return undefined;
}

/** Check to see if the user can connect to a server. */
Oa.prototype.isAuthHost = function(host, user) {
	if ( !host.users && !host.groups ) { return true; }
	if ( user ) {
		if ( host.users && host.users.indexOf(user.username) !== -1 ) { return true; }
		if ( host.groups && host.groups.indexOf(user.group) !== -1 ) { return true; }
	}
	return false;
}

/** Determine if there's a server for this path. */
Oa.prototype.findHost = function(path, user) {
	// Set the default.
	var host = undefined;
	try {
		if ( this.data.general.default && this.data.hosts[this.data.general.default] ) {
			host = this.data.hosts[this.data.general.default]; }
		
		if ( this.data.hosts[path] !== undefined ) {
			host = this.data.hosts[path];
		} else if ( path.substr(0,5) === 'port_' ) {
			var port = parseInt(path.substr(5));
			for(var k in this.data.hosts) {
				var h = this.data.hosts[k];
				if ( h.port === port && (h.host === 'localhost' || h.host === '127.0.0.1') ) {
					host = h;
					break;
				}
			}
		}
	} catch(err) { }
	
	// If we aren't authorized, return a string informing Oa as such.
	if (host && !this.isAuthHost(host, user)) {
		return 'no-auth'; }
	
	// Don't handle auth for now, just return the host.
	return host;
}

/*******************************************************************************
 * WebSocket Crap
 ******************************************************************************/

/** Calculate a response for a WebSocket handshake. */
var calc_response = function(key1,key2,key3) {
	// Create a hash thingy.
	var md5 = crypto.createHash('md5');
	[key1,key2].forEach(function(k){
		var n = parseInt(k.replace(/[^\d]/g,'')),
			s = k.replace(/[^ ]/g,'').length;
		
		if ( n > 4294967295 || s === 0 || n % s !== 0 ) {
			throw new Error("The provided keys aren't valid."); }
		n /= s;
		
		md5.update(String.fromCharCode(
			n >> 24 & 0xFF,
			n >> 16 & 0xFF,
			n >> 8  & 0xFF,
			n       & 0xFF));
	});
	
	// Tack on key3
	md5.update(key3);
	
	// Return the digest as a string.
	return md5.digest('binary');
}

/** Read the frame length from data. */
var readFrameLength = function readFrameLength(data) {
	var len	= 0,
		c	= 0;
	
	for(var l=data.length;c<l;c++) {
		var b = data.charCodeAt(c);
		len = (len * 128) + (b & 0x7F);
		if ((b & 0x80) === 0) { break; }
	}
	
	return [len,consumed];
}

/** Read a frame of WebSocket data. */
var readWebSocket = function readWebSocket(data) {
	// First, decode data. Buffers are too much hassle.
	data = data.toString('binary');
	
	// If we have old buffer, add to it.
	if ( this.old_buf ) {
		data = this.old_buf = data;
		delete this.old_buf;
	}
	
	// Are we expecting a frame?
	if ( this.expect_frame ) {
		this.expect_frame = false;
		this.frame = data.charCodeAt(0);
		if ( (this.frame & 0x80) === 0x80 ) {
			var consumed = readFrameLength(data);
			var len = consumed.shift();
			data = data.substr(consumed[0]);
		} else {
			data = data.substr(1); }
	}
	
	// Is it a simple frame?
	if ( (this.frame & 0x80) === 0 ) {
		// Read until 0xFF.
		var ind = data.indexOf('\xFF');
		if ( ind === -1 ) {
			this.old_buf = data;
			return; }
		
		// Read everything up to that byte.
		do_stuff(this, new Buffer(data.substr(0,ind), 'binary').toString('utf8'));
		this.expect_frame = true;
		
		// If there's any left over, handle it too.
		if ( data.length-1 > ind ) {
			readWebSocket.call(this, data.substr(ind+1)); }
	}
	
	// Guess not.
	else {
		// Read until we have enough bytes.
		if ( data.length >= this.frame_length ) {
			do_stuff(data.substr(0, this.frame_length));
			this.expect_frame = true;
			
			if ( data.length > this.frame_length ) {
				readWebSocket.call(this, data.substr(this.frame_length+1)); }
		} else {
			// Not enough yet.
			this.old_buf = data;
			return; }
	}
}

var do_stuff = function(stream,data) {
	if ( stream.proxied ) {
		stream.proxied.write(data, 'binary');
		return; }
	
	if ( stream.state === 0 ) {
		readInitial.call(stream, data);
		return;
	} else if ( stream.state === 1 ) {
		stream.telnet.read(data);
		return;
	}
	
	// ECHO it!
	stream.message(data);
}

/** Parse an HTTP header */
var parseHeader = function parseHeader(stream) {
	var extra = stream.buf.split('\r\n\r\n');
	var head = extra.shift();
	extra = extra.join('\r\n\r\n');
	
	var head = head.split('\r\n');
	var status = head.shift(),
		headers = {};
	
	for(var i=0,l=head.length;i<l;i++) {
		var h = head[i].split(': ');
		var n = h.shift();
		headers[n] = h.join(': ');
	}
	
	// Is the status valid? If not, abandon now.
	if (m = /^GET \/([\S]*) HTTP\/1.1$/.exec(status)) {
		stream.path = m[1];
	} else {
		stream.destroy();
		return; }
	
	// Check for the Upgrade header. If it doesn't exist, then we can't handle
	// this request. Output an error and quit.
	if (headers['Upgrade'] === undefined) {
		var body = ['<!DOCTYPE html>'];
		body.push('<html>');
		body.push('\t<head>');
		body.push('\t\t<title>400 Bad Request</title>');
		body.push('\t</head>');
		body.push('\t<body>');
		body.push('\t\t<h1>400 Bad Request</h1>');
		body.push('\t\t<p>This server will only serve WebSockets.</p>');
		body.push('\t\t<hr>');
		body.push('\t\t<p><i style="color:#600">Red Lantern MUD Proxy</i></p>');
		body.push('\t</body>');
		body.push('</html>');
		
		body = body.join('\n');
		var resp = ['HTTP/1.1 400 Bad Request'];
		resp.push('Server: RedLantern/'+stream.Oa.version);
		resp.push('Connection: close');
		resp.push('Content-Type: text/html');
		resp.push('Content-Length: '+body.length);
		resp.push('');
		resp.push(body);
		stream.write(resp.join('\r\n'),'ascii');
		stream.end();
		return;
	}
	
	// Ensure we have the necessary headers.
	var is_valid = true;
	for (var k in MANDATORY_HEADERS) {
		var v = MANDATORY_HEADERS[v];
		if (headers[k] === undefined || (v && headers[k] !== v)) {
			 is_valid = false; break; }
	}
	
	// Check for the presence of a Sec-WebSocket header.
	if ( headers['Sec-WebSocket-Key2'] !== undefined ) {
		try {
			stream.challenge = calc_response(
				headers['Sec-WebSocket-Key1'],
				headers['Sec-WebSocket-Key2'],
				extra);
		} catch(err) {
			// Invalid header thingy. Drop it.
			stream.destroy();
			return; }
	}
	
	// Check for the Host header.
	if ( headers['Host'] !== undefined ) {
		stream.loc = 'ws://' + headers['Host'] + '/' + stream.path; }
	
	// The Origin header.
	if ( headers['Origin'] !== undefined ) {
		stream.origin = headers['Origin'];
		is_valid &= stream.Oa.checkOrigin(stream.origin);
	}
	
	// Are we valid?
	if (! is_valid ) {
		stream.destroy();
		return; }
	
	// Congratulations! It's a baby websocket! Send the handshake.
	send_handshake(stream);
	stream.state_ws = true;
	
	// Send a banner.
	stream.Oa.sendBanner(stream);
	
	// Try getting a username and password from the path.
	var user = undefined, path = stream.path;
	if ( path.indexOf('@') !== -1 ) {
		path = path.split('@');
		var username = path.shift(), password = '';
		if ( username.indexOf(':') !== -1 ) {
			var t = username.split(':');
			username = t.shift();
			password = t.join(':');
		}
		path = path.join('@');
		
		// Check for a user.
		if ( username ) {
			user = stream.Oa.checkUser(username, password);
			if ( user ) {
				sys.log('St.'+stream.id+' - Authenticated As: ' + username);
			} else if ( password ) {
				sys.log('St.'+stream.id+' - Invalid Login: ' + username + ':' + password);
			}
		}
	}
	
	// If path isn't 'menu', try finding a server.
	if ( path !== 'menu' ) {
		var host = stream.Oa.findHost(path, user);
		if ( host && typeof host !== 'string' ) {
			stream.connectTo(host.host, host.port);
			return;
		} else if ( host ) {
			stream.message("  You don't have permission to connect to that host.");
			stream.destroy();
			return;
		}
	}
	
	// Still here? Show the menu.
	var tn = new menu.Telnet(stream,user);
	stream.state = 1;
}

/** Send a WebSocket handshake. */
var send_handshake = function(stream) {
	var out = ['HTTP/1.1 101 WebSocket Protocol Handshake'];
	if ( stream.challenge ) {
		out.push('Sec-WebSocket-Origin: ' + stream.origin);
		out.push('Sec-WebSocket-Location: ' + stream.loc);
	} else {
		out.push('WebSocket-Origin: ' + stream.origin);
		out.push('WebSocket-Location: ' + stream.loc); }
	
	out.splice(1,0,'Upgrade: WebSocket');
	out.splice(1,0,'Connection: Upgrade');
	out.push('\r\n');
	out = out.join('\r\n');
	if ( stream.challenge ) { out += stream.challenge; }
	
	// Actually send it.
	stream.write(out, 'binary');
}

/** Send a message to a stream, wrapping if it's a websocket. */
var message = function(data) {
	if ( this.state_ws ) {
		this.write('\x00','binary');
		if ( typeof data === 'string' ) {
			this.write(data, 'utf8');
		} else {
			this.write(data.toString('binary'),'utf8'); }
		this.write('\xFF','binary');
	} else {
		if ( typeof data === 'string' ) {
			this.write(data, 'binary');
		} else {
			this.write(data); }
	}
}

/** Connect to a proxied thingy. */
var connectTo = function(host, port) {
	var st = net.Stream(),
		owner = this;
	
	// Speed things up.
	st.setNoDelay(true);
	
	st.on('data',function(data) { owner.message(data); });
	st.on('end',function(){ owner.end(); });
	st.on('timeout',function(){
		this.destroy();
		owner.destroy(); });
	st.on('close',function(){ this.destroy(); owner.destroy(); });
	
	var out = '';
	if ( host === 'localhost' || host === '127.0.0.1' ) {
		out = p(9,'Red Lantern',null,' is forwarding you to port '+port+'...\r\n\r\n');
	} else {
		out = p(9,'Red Lantern',null,' is forwarding you to: '+host,8,':',null,port+'...\r\n\r\n');
	}
	
	// Show the message.
	owner.message(out);
	
	// Try connecting.
	owner.proxied = st;
	st.connect(port, host);
}	

// Exports
exports.Oa = Oa;
