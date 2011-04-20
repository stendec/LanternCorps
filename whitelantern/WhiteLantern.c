/*
   WhiteLantern

   Copyright 2010 Vigud@lac.pl, Lam@lac.pl

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */

#define MSL 8192 /* MAX_STRING_LENGTH */
#define MAX_LLEN 2048
/* #define SYSLOG */

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <time.h>
#include <signal.h>
#include <fcntl.h>
#include <netdb.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <arpa/telnet.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <locale.h>
#include <limits.h>
#include "md5.h"
#include "ini.h"
#include "log.h"


#if CHAR_BIT != 8
# error This code will not work on architectures where char is not 8 bits long.
#endif

#if !defined( __GNUC__ ) || __GNUC__ < 4
# define __attribute__( x )
#endif


#define FILL_SERVER_BUFFER( node ) fill_buffer \
		( node, node->server.socket_fd, node->client.buffer, \
		sizeof( node->client.buffer ), &node->client.length )

#define FILL_SERVER_PREBUFFER( node ) fill_buffer \
		( node, node->server.socket_fd, node->client.prebuf, \
		sizeof( node->client.prebuf ), &node->client.prelen )

#define FILL_CLIENT_BUFFER( node ) fill_buffer \
		( node, node->client.socket_fd, node->server.buffer, \
		sizeof( node->server.buffer ), &node->server.length )

#define FILL_CLIENT_PREBUFFER( node ) fill_buffer \
		( node, node->client.socket_fd, node->server.prebuf, \
		sizeof( node->server.prebuf ), &node->server.prelen )

#define SEND_TO_SERVER( node ) empty_buffer \
		( node, node->server.socket_fd, node->server.buffer, &node->server.length );

#define SEND_TO_CLIENT( node ) empty_buffer \
		( node, node->client.socket_fd, node->client.buffer, &node->client.length );

#define WRITE( fildes, buf ) \
do { \
	ssize_t w = write( fildes, buf, strlen( buf ) ); \
	if ( w > 0 ) \
		bytes_sent += (unsigned long int) w; \
} while ( 0 );

#define UPPER( c ) ( ( c ) >= 'a' && ( c ) <= 'z' ? ( c ) + 'A' - 'a' : ( c ) )


typedef struct mud_entry_data MUD_ENTRY;
typedef struct node_data NODE;
typedef struct peer_data PEER;

enum ConnectionType
{
	UNKNOWN,
	TELNET,
	WEB_SOCKETS
};

struct mud_entry_data
{
	char *host;
	char *port;
	char *name;
	MUD_ENTRY *next;
};

struct peer_data
{
	int socket_fd;
	size_t length;
	char buffer[ MSL ];
	size_t prelen;
	char prebuf[ MSL ];
};

struct node_data
{
	NODE *next;
	PEER server;
	PEER client;
	char host[ 40 ]; /* 2001:0db8:85a3:0000:0000:8a2e:0370:7334 */
	enum ConnectionType type;
	int menu;
	time_t date;
};


static void gentle_exit( int sig );
static void start_listening( void );
static void disconnect( NODE *node );
static void connect_to_mud( NODE *node, MUD_ENTRY *entry );
static void accept_connection( void );
static int fill_buffer( NODE *node, int file, char *inbuf, size_t bufsize, size_t *len );
static void empty_buffer( NODE *node, int file, char *outbuf, size_t *len );
static int on_server_data( NODE *node );
static int on_client_data( NODE *node );
static void the_main_loop( void );
static int read_menu_choice( NODE *node );
static int determine_connection_type( NODE *node );
static void banner( NODE *node );
static int parse_headers( NODE *node );
static int ws_encode( NODE *node );
static int ws_decode( NODE *node );
static void parse_options( int argc, char **argv );
static int parse_ini_entry( const char *section, const char *name, const char *value );
static char *stristr( char *String, const char *Pattern, int end );


/* Globals */
int keep_running = 1;
NODE *node_list;
NODE *reuse_list;
MUD_ENTRY *mud_entries;
int listen_socket;
uint16_t listen_port = 8017;
const char *default_port = "4000";
const char *default_host = "127.0.0.1";
unsigned long int bytes_recv, bytes_sent;
unsigned long int nodes_allocated;
unsigned long int node_count;


int main( int argc, char **argv )
{
	setlocale( LC_CTYPE, "en_US.UTF-8" );
	OPENLOG( "WhiteLantern", LOG_PID, LOG_LOCAL4 ); /* Caution: LOG_LOCAL4 */
	parse_options( argc, argv );
	signal( SIGINT, gentle_exit );
	start_listening( );
	the_main_loop( );

	wraplog( "Bytes received: %lu, sent: %lu.", bytes_recv, bytes_sent );
	wraplog( "Nodes allocated: %lu.", nodes_allocated );

	return 0;
}


static void gentle_exit( int sig )
{
	wraplog( "\nWhiteLantern exits after catching signal %d.", sig );
	keep_running = 0;

	return;
}


static void start_listening( void )
{
	static struct sockaddr_in6 sa_zero;
		   struct sockaddr_in6 sa;
	int x = 1;

	listen_socket = socket( AF_INET6, SOCK_STREAM, 0 );

	if ( listen_socket < 0 )
	{
		wraperror( "start_listening: socket" );
		exit( 1 );
	}

	if ( setsockopt( listen_socket, SOL_SOCKET, SO_REUSEADDR,
					 (char *) &x, sizeof( x ) ) < 0 )
	{
		wraperror( "start_listening: SO_REUSEADDR" );
		close( listen_socket );
		exit( 1 );
	}

	sa			    = sa_zero;
	sa.sin6_family  = AF_INET6;
	sa.sin6_port	= htons( listen_port );

	if ( bind( listen_socket, (struct sockaddr *) &sa, sizeof( sa ) ) < 0 )
	{
		wraperror( "start_listening: bind" );
		close( listen_socket );
		exit( 1 );
	}

	if ( listen( listen_socket, 5 ) < 0 )
	{
		wraperror( "start_listening: listen" );
		close( listen_socket );
		exit( 1 );
	}

	fcntl( listen_socket, F_SETFL, O_NONBLOCK );
	wraplog( "WhiteLantern: listening on port %d.", listen_port );

	if ( !mud_entries )
		wraplog( "WhiteLantern: default host: %s:%s.", default_host, default_port );

	return;
}


static void disconnect( NODE *node )
{
	NODE *node2;

	wraplog( "Disconnecting client: %s/%d, current node count: %lu",
			 node->host, node->client.socket_fd, node_count );

	if ( node->server.socket_fd )
		close( node->server.socket_fd );

	if ( node->client.socket_fd )
		close( node->client.socket_fd );

	node->server.socket_fd = node->client.socket_fd = 0;

	if ( node_list == node )
		node_list = node->next;
	else
		for ( node2 = node_list; node2; node2 = node2->next )
			if ( node2->next == node )
			{
				node2->next = node->next;
				break;
			}

	node->next = reuse_list;
	reuse_list = node;
	node_count--;

	return;
}


static void connect_to_mud( NODE *node, MUD_ENTRY *entry )
{
	struct addrinfo hints, *res;
	const char *host, *port;

	memset( &hints, 0, sizeof( hints ) );

	hints.ai_family = AF_UNSPEC; /* IPv4 or IPv6 */
	hints.ai_socktype = SOCK_STREAM;

	if ( !entry )
	{
		host = default_host;
		port = default_port;
	}
	else
	{
		host = entry->host;
		port = entry->port;
	}

	if ( getaddrinfo( host, port, &hints, &res ) )
	{
		WRITE( node->client.socket_fd, "Wrong host.\n\r" );
		wraplog( "Wrong host!" );
		disconnect( node );
		return;
	}

	node->server.socket_fd = socket( res->ai_family, res->ai_socktype, res->ai_protocol );
	if ( node->server.socket_fd < 0 )
	{
		WRITE( node->client.socket_fd, "Wrong socket.\n\r" );
		wraplog( "Wrong socket!" );
		disconnect( node );
		freeaddrinfo( res );
		return;
	}

	if ( connect( node->server.socket_fd, res->ai_addr, res->ai_addrlen ) < 0 )
	{
		WRITE( node->client.socket_fd, "Could not connect to game.\n\r" );
		wraplog( "Could not connect to game." );
		disconnect( node );
		freeaddrinfo( res );
		return;
	}

	freeaddrinfo( res );

	return;
}


static void accept_connection( void )
{
	NODE *node;
	struct sockaddr_in6 sock;
	unsigned int socksize = sizeof( sock );
	char buf[ 128 ];
	int socket_fd = accept( listen_socket, (struct sockaddr *) &sock, &socksize);

	if ( socket_fd < 0 )
	{
		wraperror( "accept_connection: accept" );
		return;
	}

	if ( ( fcntl( socket_fd, F_SETFL, O_NONBLOCK ) ) < 0 )
	{
		wraperror( "accept_connection: fcntl" );
		return;
	}

	if ( ( getpeername( socket_fd, (struct sockaddr *) &sock, &socksize ) ) < 0 )
	{
		wraperror( "accept_connection: getpeername" );
		return;
	}

	if ( !reuse_list )
	{
		nodes_allocated++;
		node = calloc( sizeof( NODE ), 1 );
	}
	else
	{
		node = reuse_list;
		reuse_list = reuse_list->next;
		memset( node, 0, sizeof( NODE ) );
	}

	node_count++;
	node->client.socket_fd = socket_fd;
	node->next = node_list;
	node->type = UNKNOWN;
	time( &node->date );
	node_list = node;

	if ( !inet_ntop( sock.sin6_family, &sock.sin6_addr, buf, sizeof( buf ) ) )
	{
		wraperror( "accept_connection: inet_ntop" );
		disconnect( node );
		return;
	}

	buf[ 39 ] = '\0';
	if ( !strncmp( buf, "::ffff:", 7 ) )
		strcpy( node->host, buf + 7 );
	else
		strcpy( node->host, buf );

	wraplog( "Accepted connection from %s/%d, current node count: %lu",
			 node->host, node->client.socket_fd, node_count );

	return;
}


static int fill_buffer( NODE *node, int file, char *inbuf, size_t bufsize, size_t *len )
{
	size_t llen = *len;
	ssize_t count = read( file, inbuf + llen, bufsize - llen );
	unsigned long int ucount = (unsigned long int) count;

	if ( count > 0 )
	{
		inbuf[ llen + ucount ] = '\0';
		*len = llen + ucount;
		bytes_recv += ucount;
		return 1;
	}
	else if ( count == 0 )
	{
		wraplog( "Client %s disconnected (EOF)", node->host );
		return 0;
	}
	else if ( errno == EWOULDBLOCK || errno == EAGAIN )
		return 1;
	else
	{
		wraperror( "fill_buffer (%s)", node->host );
		return 0;
	}
}


static void empty_buffer( NODE *node, int file, char *outbuf, size_t *len )
{
	size_t llen = *len;
	size_t count;
	ssize_t scount;

	while ( llen )
	{
		if ( llen <= MAX_LLEN )
		{
			scount = write( file, outbuf, llen );

			if ( scount < 0 )
			{
				if ( errno == EWOULDBLOCK || errno == EAGAIN )
					return;

				wraperror( "empty_buffer (%s)", node->host );
				disconnect( node );
				return;
			}

			count = (size_t) scount;
			bytes_sent += count;

			if ( count < llen )
			{
				memmove( &outbuf[ 0 ], &outbuf[ count ], *len - count );
				*len -= count;
				return;
			}

			break;
		}

		scount = write( file, outbuf, MAX_LLEN );

		if ( scount < 0 )
		{
			if ( errno == EWOULDBLOCK || errno == EAGAIN )
					return;

			wraperror( "empty_buffer (%s)", node->host );
			disconnect( node );
			return;
		}

		count = (size_t) scount;
		bytes_sent += count;

		if ( count < MAX_LLEN )
		{
			memmove( &outbuf[ 0 ], &outbuf[ count ], *len - count );
			*len -= count;
			return;
		}

		*len = llen -= MAX_LLEN;
		memmove( &outbuf[ 0 ], &outbuf[ MAX_LLEN ], *len );
	}

	outbuf[ 0 ] = '\0';
	*len = 0;

	return;
}


static int on_server_data( NODE *node )
{
	if ( node->type == TELNET )
		return FILL_SERVER_BUFFER( node );

	if ( !FILL_SERVER_PREBUFFER( node ) )
		return 0;

	if ( node->type == WEB_SOCKETS )
		return ws_encode( node );

	wraplog( "on_server_data: Bug: unknown connection type %d, client %s/%d",
			 node->type, node->host, node->client.socket_fd );

	return 0;
}


static int on_client_data( NODE *node )
{
	if ( node->menu == 1 )
		return read_menu_choice( node );

	if ( node->type == TELNET )
		return FILL_CLIENT_BUFFER( node );

	if ( !FILL_CLIENT_PREBUFFER( node ) )
		return 0;

	if ( node->type == WEB_SOCKETS )
		return ws_decode( node );

	if ( node->type == UNKNOWN )
		return determine_connection_type( node );

	wraplog( "on_client_data: Bug: unknown connection type %d, client %s/%d",
			 node->type, node->host, node->client.socket_fd );

	return 0;
}


static void the_main_loop( void )
{
	struct timeval tv;
	fd_set in_set, out_set, exc_set;
	int maxdsc, outgoing;
	NODE *node, *next_node;
	time_t now;

	signal( SIGPIPE, SIG_IGN );

	while ( keep_running )
	{
		FD_ZERO( &in_set );
		FD_ZERO( &out_set );
		FD_ZERO( &exc_set );

		maxdsc = listen_socket;

		/* Are you getting "conversion to 'unsigned int' from 'int' may change
		   the sign of the result" warning?
		   See https://bugzilla.novell.com/show_bug.cgi?id=651597 */
		FD_SET( listen_socket, &in_set );
		outgoing = 0;
		time( &now );

		for ( node = node_list; node; node = node->next )
		{
			if ( node->type == UNKNOWN
			  && difftime( now, node->date ) > 2 )
			{
				node->type = TELNET;
				banner( node );
			}

			if ( node->server.socket_fd )
			{
				outgoing = 1;
				if ( maxdsc < node->server.socket_fd )
					maxdsc = node->server.socket_fd;
				FD_SET( node->server.socket_fd, &in_set );
				FD_SET( node->server.socket_fd, &out_set );
				FD_SET( node->server.socket_fd, &exc_set );
			}

			if ( node->client.socket_fd )
			{
				outgoing = 1;
				if ( maxdsc < node->client.socket_fd )
					maxdsc = node->client.socket_fd;
				FD_SET( node->client.socket_fd, &in_set );
				FD_SET( node->client.socket_fd, &out_set );
				FD_SET( node->client.socket_fd, &exc_set );
			}
		}

		if ( outgoing )
		{
			tv.tv_usec = 0;
			tv.tv_sec  = 1;
			select( maxdsc + 1, &in_set, NULL, &exc_set, &tv );
			select( maxdsc + 1, NULL, &out_set, NULL, NULL );
		}
		else
			select( maxdsc + 1, &in_set, NULL, &exc_set, NULL );

		if ( FD_ISSET( listen_socket, &in_set ) && keep_running )
			accept_connection( );

		for ( node = node_list; node; node = next_node )
		{
			next_node = node->next;

			if ( FD_ISSET( node->server.socket_fd, &exc_set )
			  || FD_ISSET( node->client.socket_fd, &exc_set ) )
			{
				wraplog( "Disconnecting: %s/%d (exception)", node->host,
						 node->client.socket_fd );
				disconnect( node );
				continue;
			}

			if ( FD_ISSET( node->server.socket_fd, &in_set )
			  && !on_server_data( node ) )
			{
				disconnect( node );
				continue;
			}

			if ( FD_ISSET( node->client.socket_fd, &in_set )
			  && !on_client_data( node ) )
			{
				disconnect( node );
				continue;
			}

			if ( node->server.length > 0
			  && FD_ISSET( node->server.socket_fd, &out_set ) )
			{
				SEND_TO_SERVER( node );
			}

			if ( node->client.length > 0
			  && FD_ISSET( node->client.socket_fd, &out_set ) )
			{
				SEND_TO_CLIENT( node );
			}
		}
	}

	return;
}


static int read_menu_choice( NODE *node )
{
	int resp;
	char buf[ MSL ];
	MUD_ENTRY *e = mud_entries;

	if ( node->type == TELNET
	  && !FILL_CLIENT_BUFFER( node ) )
	{
		return 0;
	}

	if ( node->type == WEB_SOCKETS
	  && ( !FILL_CLIENT_PREBUFFER( node ) || !ws_decode( node ) ) )
	{
		return 0;
	}

	strcpy( buf, node->server.buffer );
	node->server.length = 0;
	node->server.buffer[ 0 ] = '\0';

	if ( buf[ 0 ] == 'Q' || buf[ 0 ] == 'q' )
		return 0;

	if ( ( resp = atoi( buf ) ) > 0 )
	{
		for ( --resp; resp && e; resp-- )
			e = e->next;

		if ( e )
		{
			node->menu = 0;
			connect_to_mud( node, e );
			return 1;
		}
	}

	sprintf( node->client.buffer,
			 "\x1b[38;5;2mSelect a mud, or Q to quit\x1b[38;5;8m:\x1b[0m " );
	node->client.length = strlen( node->client.buffer );

	return 1;
}


static int determine_connection_type( NODE *node )
{
	if ( !strncmp( node->server.prebuf, "GET ", 4 ) )
	{
		char *rnrn = strstr( node->server.prebuf, "\r\n\r\n" );

		if ( !rnrn && node->server.prelen > 1024 )
		{
			wraplog( "Over 1024 bytes of headers, disconnecting." );
			return 0;
		}

		if ( !rnrn || strlen( rnrn ) < 12 )
			return 1;

		return parse_headers( node );
	}

	if ( node->server.prelen < 23 )
		return 1;

	if ( !strncmp( node->server.prebuf,
				   "<policy-file-request/>\x00", 23 ) )
	{
		sprintf( node->client.buffer,
				 "<?xml version=\"1.0\"?>\n"
				 "<!DOCTYPE cross-domain-policy SYSTEM \"/xml/dtds/cross-domain-policy.dtd\">\n"
				 "<cross-domain-policy>\n"
				 "    <allow-access-from domain=\"*\" to-ports=\"%d\" />\n"
				 "</cross-domain-policy>",
				 listen_port );
		
		WRITE( node->client.socket_fd, node->client.buffer );
		return 0;
	}

	wraplog( "Couldn't determine connection type from %s/%d",
			 node->host, node->client.socket_fd );

	return 0;
}


static void banner( NODE *node )
{
	int i = 1;
	char *buf;
	size_t *len;
	MUD_ENTRY *e;

	if ( !mud_entries )
	{
		connect_to_mud( node, NULL );
		return;
	}

	if ( node->type == TELNET )
	{
		buf = node->client.buffer;
		len = &node->client.length;
	}
	else
	{
		buf = node->client.prebuf;
		len = &node->client.prelen;
	}

	node->menu = 1;

	/* You're free to remove or replace the following sentence: */
	buf += sprintf( buf,
					"This is WhiteLantern,"
					" written by Vigud@lac.pl and Lam@lac.pl\n" );

	for ( e = mud_entries; e; e = e->next )
		buf += sprintf( buf, "%d. %s\n", i++, e->name );

	sprintf( buf,
			 "\x1b[38;5;2mSelect a mud, or Q to quit\x1b[38;5;8m:\x1b[0m " );

	*len = strlen( node->client.buffer );

	if ( node->type == WEB_SOCKETS )
		ws_encode( node );

	return;
}


static int parse_headers( NODE *node )
{
	char *swk[ 3 ];
	uint32_t key[ 2 ];
	unsigned long int spaces[ 2 ];
	char *origin, *host;
	char *onr, *htr;
	char *header, *response;
	char buffer[ 17 ];
	int idx, i;
	MD5_CTX mdContext;

	header = node->server.prebuf;
	response = node->client.buffer;

/* These headers are based on the original example from the RFC. If you copy
   this into server buffer, you'll see if calculated response is ok, comparing
   to the response example given in the RFC. */
#if 0
	strcpy( header,
		"GET /menu HTTP/1.1\r\n"
		"Connection: Upgrade\r\n"
		"Host: example.com\r\n"
		"Upgrade: WebSocket\r\n"
		"Sec-WebSocket-Key1: 3e6b263  4 17 80\r\n"
		"Origin: http://example.com\r\n"
		"Sec-WebSocket-Key2: 17  9 G`ZD9   2 2b 7X 3 /r90\r\n"
		"\r\n"
		"WjN}|M(6\r\n" );
#endif

	if ( !stristr( header, "GET /menu HTTP/1.1\r\n", 0 )
	  || !stristr( header, "\r\nUpgrade: WebSocket\r\n", 0 )
	  || !stristr( header, "\r\nConnection: Upgrade\r\n", 0 )
	  || !( swk[ 0 ] = stristr( header, "\r\nSec-WebSocket-Key1: ", 1 ) )
	  || !( swk[ 1 ] = stristr( header, "\r\nSec-WebSocket-Key2: ", 1 ) )
	  || !( swk[ 2 ] = stristr( header, "\r\n\r\n", 1 ) )
	  || !( origin   = stristr( header, "\r\nOrigin: ", 1 ) )
	  || !( host     = stristr( header, "\r\nHost: ", 1 ) )
	  || !( onr = strchr( origin, '\r' ) )
	  || !( htr = strchr( host, '\r' ) ) )
	{
		wraplog( "Something is missing. This is what I got:\n%s", header );
		/* FIXME: HTTP 400 */
		return 0;
	}

	*onr = *htr = '\0';

	/* Regarding the cast to unsigned char in isdigit(): it seems that on NetBSD
	   isdigit() is a macro retrieving the value it returns from an array, and
	   its parameter is used as index in that array. GCC reports that it's not
	   safe to use variable of signed type as an array index, hence the cast. */

	for ( i = 0; i < 2; i++ )
	{
		key[ i ] = spaces[ i ] = 0;

		for ( idx = 0; *swk[ i ] != '\r'; swk[ i ]++ )
		{
			if ( *swk[ i ] == ' ' )
			{
				spaces[ i ]++;
				continue;
			}

			if ( *swk[ i ] < 0 || !isdigit( (unsigned char) *swk[ i ] ) )
				continue;

			buffer[ idx ] = *swk[ i ];

			if ( ++idx > 10 )
				return 0;
		}

		buffer[ idx ] = '\0';
		key[ i ] = strtoul( buffer, (char **) NULL, 10 );

		if ( spaces[ i ] == 0 || key[ i ] % spaces[ i ] != 0 )
			return 0;

		key[ i ] = htonl( key[ i ] / spaces[ i ] );
	}

	memcpy( &buffer[ 0 ], &key[ 0 ], 4 );
	memcpy( &buffer[ 4 ], &key[ 1 ], 4 );
	memcpy( &buffer[ 8 ],  swk[ 2 ], 8 );

	MD5Init( &mdContext );
	MD5Update( &mdContext, (unsigned char *) buffer, 16 );
	MD5Final( &mdContext );

	memcpy( buffer, mdContext.digest, 16 );
	buffer[ 16 ] = '\0';

	sprintf( response,
		"HTTP/1.1 101 WebSocket Protocol Handshake\r\n"
		"Upgrade: WebSocket\r\n"
		"Connection: Upgrade\r\n"
		"Sec-WebSocket-Origin: %s\r\n"
		"Sec-WebSocket-Location: ws://%s/menu\r\n"
		"\r\n"
		"%s",
		origin,
		host,
		buffer );

	wraplog( "Client %s/%d started WebSocket connection.",
			 node->host, node->client.socket_fd );

	WRITE( node->client.socket_fd, response );

	node->server.buffer[ 0 ] = node->server.prebuf[ 0 ] = '\0';
	node->client.length = node->server.prelen = 0;
	node->type = WEB_SOCKETS;
	banner( node );

	return 1;
}


static int ws_encode( NODE *node )
{
	char *buffer = node->client.buffer;
	char *prebuf = node->client.prebuf;
	size_t *length = &node->client.length;
	size_t *prelen = &node->client.prelen;
	size_t i;
	int wclen;

	*buffer++ = 0x00;
	for ( i = 0; i < *prelen; i++ )
	{
		wclen = wctomb( buffer, (unsigned char) prebuf[ i ] );
		if ( wclen == -1 )
		{
			wraplog( "wctomb returned -1" );
			return 0;
		}
		else if ( wclen == 0 )
		{
			buffer++;
			continue;
		}
		buffer += wclen;
	}
	*buffer++ = ~0;
	*buffer   = '\0';

	*length = (size_t) ( buffer - node->client.buffer );

	*prelen = 0;
	prebuf[ 0 ] = '\0';

	return 1;
}


static int ws_decode( NODE *node )
{
	char *prebuf = node->server.prebuf;
	size_t *prelen = &node->server.prelen;
	char *buffer = node->server.buffer;
	size_t *length = &node->server.length;
	char *msgstart = prebuf + 1;
	char *ff;
	int mbclen;
	wchar_t mbc;
	unsigned char ucmbc;

	/* Regarding this ucmbc thing: casting to signed char gives undefined
	   behavior while casting to unsigned char always works (ISO/IEC 9899:TC,
	   6.3.1.3 Signed and unsigned integers). Therefore I cast to unsigned char
	   before casting to char. Probably it would be better to change buffer's
	   type to unsigned char, but I'm too lazy to think about it. */

	while ( ( ff = memchr( prebuf, 0xFF, *prelen ) ) )
	{
		mbtowc( (wchar_t *) NULL, NULL, 0 );
		*ff = '\0';
		while ( msgstart < ff )
		{
			mbclen = mbtowc( &mbc, msgstart, MB_LEN_MAX );
			if ( mbclen < 0 )
			{
				wraplog( "mbtowc() returned %d", mbclen );
				return 0;
			}
			else if ( mbclen == 0 )
			{
				*buffer++ = 0;
				msgstart++;
				continue;
			}

			ucmbc = (unsigned char) mbc;
			*buffer++ = (char) mbc;
			msgstart += mbclen;
		}
		msgstart++;
	}

	*length = (size_t) ( buffer - node->server.buffer );
	*prelen = (size_t) ( prebuf + *prelen - msgstart );
	
	if ( *prelen == 0 )
		prebuf[ 0 ] = '\0';
	else
		memmove( prebuf, ff + 1, *prelen - 1 );

	return 1;
}


static void parse_options( int argc, char **argv )
{
	int i;

	for ( i = 1; i < argc; i++ )
	{
		const char *option = argv[ i ];
		const char *parameter = i + 1 < argc ? argv[ i + 1 ] : NULL;

		if ( !strcmp( option, "--help" ) )
		{
			printf( "Usage: %s [-<option> <value>]\n\n", argv[ 0 ] );
			printf( "Options (default values):\n"
				"\tmp: mud port (%s)\n"
				"\tmh: mud host (%s)\n"
				"\tlp: listen port (%d)\n"
				"\tcf: configuration file (none)\n\n",
				default_port, default_host, listen_port );
			printf( "Example: %s -mh lac.pl -mp 4000 -lp 3998\n", argv[ 0 ] );
			exit( 0 );
		}

		if ( parameter )
			i++;
		else
		{
			printf( "No parameter for option %s given.\n", option );
			break;
		}

		if ( !strcmp( option, "-lp" ) )
		{
			int port = atoi( parameter );

			if ( port > 0 && port < 65535 )
				listen_port = (uint16_t) port;
			else
				printf( "Port can range from 1 to 65535.\n" );
		}

		else if ( !strcmp( option, "-cf" ) )
		{
			int line = ini_parse( parameter, parse_ini_entry );

			if ( line != 0 )
			{
				printf( "Error in config file on line %d.\n", line );
				exit( 1 );
			}
		}

		else if ( !strcmp( option, "-mp" ) )
			default_port = parameter;

		else if ( !strcmp( option, "-mh" ) )
			default_host = parameter;

		else
		{
			printf( "Invalid option \"%s\".", option );
			exit( 1 );
		}
	}

	return;
}


static int parse_ini_entry( const char *section, const char *name, const char *value )
{
	MUD_ENTRY *new;
	static const char *last_sect = NULL;

	if ( strncmp( section, "host:", 5 ) )
		return 1;

	if ( last_sect != section )
	{
		new = calloc( sizeof( MUD_ENTRY ), 1 );
		new->next = mud_entries;
		mud_entries = new;
		last_sect = section;
	}

	if ( !strcmp( name, "port" ) )
		mud_entries->port = strdup( value );
	else if ( !strcmp( name, "host" ) )
		mud_entries->host = strdup( value );
	else if ( !strcmp( name, "name" ) )
		mud_entries->name = strdup( value );
	else
		wraplog( "Invalid key \"%s\".", name );

	return 1;
}


/*
** Designation:  StriStr
**
** Call syntax:  char *stristr(char *String, char *Pattern, int end)
**
** Description:  This function is an ANSI version of strstr() with
**               case insensitivity.
**
** Return item:  char *pointer if Pattern is found in String, else NULL
**
** Rev History:  02/03/94  Fred Cole    Original
**               07/04/95  Bob Stout    ANSI-fy
**               16/07/97  Greg Thayer  Optimized
**               09/01/03  Bob Stout    Bug fix (lines 40-41) per Fred Bulback
**               16/12/10  Vigud@lac.pl int end, UPPER(), -const for String
**
** Hereby donated to public domain.
*/
static char *stristr( char *String, const char *Pattern, int end )
{
	const char *pptr;
	char *sptr, *start;

	for ( start = String; *start != '\0'; start++ )
	{
		for ( ; *start != '\0' && UPPER( *start ) != UPPER( *Pattern ); start++ )
			;

		if ( '\0' == *start )
			return NULL;

		pptr = Pattern;
		sptr = start;

		while ( UPPER( *sptr ) == UPPER( *pptr ) )
		{
			sptr++;
			pptr++;

			if ( '\0' == *pptr )
				return end ? sptr : start;
		}
	}
	return NULL;
}
