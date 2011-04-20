/**
 * Red Lantern
 * By Stendec
 *
 * The Menu - err... Menu
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

// Requirements
var sys = require('sys');

const IAC	= '\xFF';
const DONT	= '\xFE';
const DO	= '\xFD';
const WONT	= '\xFC';
const WILL	= '\xFB';
const SB 	= '\xFA';
const SE	= '\xF0';
const ECHO	= '\x01';

String.prototype.startswith = function(st) {
	return this.substr(0,st.length) === st;
}
String.prototype.endswith = function(st) {
	return this.substr(-1*st.length) === st;
}

/** This provides a simple telnet state machine for Red Lantern, and a menu
 *  system as well. */
var Telnet = function Telnet(stream,user) {
	this.stream = stream;
	stream.telnet = this;
	this.id = stream.id;
	this.Oa = stream.Oa;
	
	this.log('New menu initialized.');
	
	// State Stuff
	this.telopt = {};
	this.iac_buf = '';
	this.buffer = '';
	this._ih = [];
	this.user = user;
	
	// Is login absolutely required?
	this.can_without = false;
	for(var k in this.Oa.data.hosts) {
		if ( this.Oa.isAuthHost(this.Oa.data.hosts[k], this.user) ) {
			this.can_without = true;
			break;
		}
	}
	
	if ( this.can_without ) {
		this.push_ih(new Menu(this));
	} else {
		this.push_ih(new Login(this));
	}
	
	this._ih[0].display();
}

/** Log */
Telnet.prototype.log = function(text) {
	sys.log('Sk.'+this.id+' - Menu - ' + text); }

/** Add an input handler. */
Telnet.prototype.push_ih = function(ih) {
	this._ih.splice(0,0,ih); }

Telnet.prototype.pop_ih = function() {
	this._ih.shift(); }

Telnet.prototype.replace_ih = function(ih) {
	this._ih.splice(0,1,ih); }

Telnet.prototype.send = function(text) {
	this.stream.message(text + '\r\n'); }

Telnet.prototype.send_raw = function(text) {
	this.stream.message(text); }
	
Telnet.prototype.read = function(data) {
	if ( this.iac_buf ) {
		data = this.iac_buf + data; }
	
	// Process the string.
	while ( data.length > 0 ) {
		var ind = data.indexOf(IAC);
		if ( ind === -1 ) {
			this.buffer += data;
			this.handleData();
			break;
		}
		
		else if ( ind > 0 ) {
			this.buffer += data.substr(0,ind);
			this.handleData();
			data = data.substr(ind);
		}
		
		var out = this.readIAC(data);
		if ( out === false ) {
			this.iac_buf = data;
			break;
		} else {
			data = out;
		}
	}
}

/** Read an IAC sequence. */
Telnet.prototype.readIAC = function(data) {
	if ( data.length < 2 ) { return false; }
	
	// Get the all-important second character.
	var c = data.charCodeAt(1);
	
	// If the second character is IAC, push IAC to the buffer and handle it.
	if ( c === 0xFF ) {
		this.buffer += IAC;
		this.handleData();
		return data.substr(2);
	}
	
	// If the second character is GA, ignore the sequence.
	else if ( c === 0xF9 ) {
		return data.substr(2);
	}
	
	// If the second character is one of WILL,WONT,DO,DONT, read it and handle.
	else if ( c > 250 && c < 255 ) {
		if ( data.length < 3 ) { return false; }
		var seq = data.substr(0,3);
		this.handleIACSimple(seq);
		return data.substr(3);
	}
	
	// If it's an IAC SB, read as much as we can to get it all.
	else if ( c === 250 ) {
		var seq, l = IAC + SE, i=0;
			code = data[2], has_iac = false;
		data = data.substr(3);
		var ind = data.indexOf(l);
		if ( ind === -1 ) { return false; }
		while(i < data.length) {
			if ( data[i] === IAC ) {
				has_iac = !has_iac;
			} else if ( data[i] === SE && has_iac ) {
				seq = data.substr(0,i-1).replace(/\xFF\xFF/g,IAC);
				data = data.substr(i+1);
				break;
			}
			i++;
		}
		if ( !seq ) { return false; }
		
		return data;
	}
	
	// Just push IAC off the stack.
	return data.susbstr(1);
}

/** Handle a simple telnet sequence. */
Telnet.prototype.handleIACSimple = function(seq) {
	// Pass
}

/** Handle incoming data that's clean of telnet bits. */
Telnet.prototype.handleData = function() {
	// No input handlers? Just keep buffering.
	if ( this._ih.length === 0 ) { return; }
	var data = this.buffer;
	this.buffer = '';
	
	// Is the input handler in line mode?
	var ih = this._ih[0];
	if ( ih.linemode === false ) {
		// Nope. Just send it all.
		ih.process(data);
		
		// Bust the prompt if we can.
		if ( this._ih.length > 0 ) {
			this._ih[0].display();
		} else {
			// Ensure GC
			delete this.stream.telnet;
			if ( this.expect_close !== true ) {
				this.stream.destroy();
				return;
			}
		}
	}
	
	// It is. Split it up by \n then.
	var last_is_line = false;
	data = data.replace(/\r/g,'');
	if ( data.substr(0,data.length-1).indexOf('\n') === -1 && data.substr(-1) === '\n' ) {
		// Single line.
		ih.process(data.substr(0,data.length-1));
	} else {
		if ( data.substr(-1) === '\n' ) { last_is_line = true; }
		var data = data.split('\n');
		var last = data.pop();
		while ( data.length > 0 ) {
			ih.process(data.shift()); }
		if ( last_is_line ) {
			ih.process(last);
		} else {
			this.buffer = last + this.buffer;
		}
	}
	
	// Bust the prompt if we can.
	if ( this._ih.length > 0 ) {
		this._ih[0].display();
	} else {
		// Ensure GC
		delete this.stream.telnet;
		if ( this.expect_close !== true ) {
			this.stream.destroy();
			return;
		}
	}
}

/** The Login input handler. */
var Login = function Login(telnet) {
	this.telnet = telnet;
	
	this.state = 0;
	this.username = '';
	this.banner = false;
}

Login.prototype.display = function() {
	if ( !this.banner ) {
		this.telnet.Oa.sendBanner(this.telnet.stream);
		this.banner = true;
	}
	
	if ( this.state === 0 ) {
		this.telnet.send_raw('\x1B[38;5;1mUsername\x1B[38;5;8m:\x1B[0m ');
	} else {
		this.telnet.send_raw('\x1B[38;5;1mPassword\x1B[38;5;8m:\x1B[0m ' + IAC + WILL + ECHO);
	}
}

Login.prototype.process = function(data) {
	if ( this.state === 0 ) {
		if ( data.length > 0 && data.replace(/[^a-zA-Z0-9\-_!@#$%^&*(),.<>]/g,'') === data ) {
			this.username = data;
			this.state = 1;
		} else if ( data.length === 0 && this.telnet.can_without ) {
			this.telnet.replace_ih(new Menu(this.telnet));
		} else {
			this.telnet.send('\x1B[38;5;9mInvalid username.');
		}
		return;
		
	} else if ( this.state === 1 ) {
		this.telnet.send_raw(IAC + WONT + ECHO);
		if ( data ) {
			// Try to authenticate.
			var user = this.telnet.Oa.checkUser(this.username, data);
			if ( user ) {
				this.telnet.send('');
				this.telnet.user = user;
				this.telnet.replace_ih(new Menu(this.telnet));
			} else {
				this.telnet.send('\x1B[38;5;9mInvalid username or password.');
				this.username = '';
				this.state = 0;
			}
		} else {
			this.state = 0;
		}
	}
}

/** The actual Menu handler. */
var Menu = function Menu(telnet) {
	this.telnet = telnet;
	this.banner = false;
}

Menu.prototype.mudlist = undefined;
Menu.prototype.muduser = undefined;
Menu.prototype.muds = undefined;
Menu.prototype.build_muds = function() {
	if ( this.telnet.user === this.muduser && this.mudlist !== undefined ) {
		return this.mudlist; }
	
	var longest = 0;
	var hosts = this.telnet.Oa.data.hosts;
	this.muds = [];
	for(var k in hosts) {
		var h = hosts[k];
		if ( this.telnet.Oa.isAuthHost(h,this.telnet.user) ) {
			var n = h.name;
			if ( !n ) { h.name = k; n = k; }
			if (n.length > longest) { longest = n.length; }
			this.muds.push(h);
		}
	}
	
	var digits = this.muds.length.toString().length,
		cols = Math.floor(80 / (longest+6)),
		out = '', col=0, ind=0;
	
	// Build the output!
	for(var i=0,l=this.muds.length;i<l;i++) {
		var h = this.muds[i];
		ind++; col++;
		var d = ind.toString();
		while ( d.length < digits ) { d = '0' + d; }
		var n = h.name;
		while ( n.length < longest ) { n += ' '; }
		out += '\x1B[38;5;126m'+d+'\x1B[38;5;8m.\x1B[0m '+n+'    ';
		if ( col > cols ) {
			col = 0;
			out += '\r\n'; }
	}
	
	if ( !out.endswith('\r\n') ) { out += '\r\n'; }
	
	this.mudlist = out;
	this.muduser = this.telnet.user;
	return out;
}

Menu.prototype.display = function() {
	if ( !this.banner ) {
		this.telnet.Oa.sendBanner(this.telnet.stream);
		this.banner = true;
		
		this.telnet.send(this.build_muds());
	}
	
	var u = this.telnet.user ? 'C host port to connect to a custom host, ' : 'L to log in, ';
	this.telnet.send_raw('\x1B[38;5;1mSelect a MUD, '+u+'or Q to quit\x1B[38;5;8m:\x1B[0m ');
}

Menu.prototype.process = function(data) {
	if ( !data ) { return; }
	
	if ( 'login'.startswith(data.split(' ')[0].toLowerCase()) ) {
		var l = data.split(' ');
		l.shift();
		this.telnet.replace_ih(new Login(this.telnet));
		while( l.length > 0 ) {
			this.telnet._ih[0].process(l.shift());
		}
		return;
	}
	
	if ( 'quit'.startswith(data.toLowerCase()) ) {
		this.telnet.pop_ih();
		return;
	}
	
	// Are we connecting to somewhere?
	if ( 'connect'.startswith(data.split(' ')[0].toLowerCase()) ) {
		if ( !this.telnet.user ) {
			this.telnet.send('\x1B[38;5;9mYou must log-in to do so.\r\n');
			return;
		}
		var to = data.split(' ');
		to.shift();
		this.telnet.expect_close = true;
		this.telnet.pop_ih();
		this.telnet.send_raw('\r\n');
		this.telnet.stream.connectTo(to[0],parseInt(to[1]));
		delete this.telnet;
		return;
	}
	
	// Try determining if it's a valid MUD.
	var n;
	try {
		n = parseInt(data);
	} catch(err) { n = 0; }
	
	if ( n < 1 || n > this.muds.length ) {
		this.telnet.send('\x1B[38;5;9mInvalid choice.\r\n');
		return;
	}
	
	// Connect to it.
	this.telnet.expect_close = true;
	this.telnet.pop_ih();
	var h = this.muds[n-1];
	this.telnet.send_raw('\r\n');
	this.telnet.stream.connectTo(h.host,h.port);
	delete this.telnet;
}

// Exports
exports.Telnet = Telnet;
exports.Login = Login;
exports.Menu = Menu;