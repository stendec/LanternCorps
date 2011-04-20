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

#include <stdarg.h>
#include <stddef.h>
#include <sys/time.h>
#include <stdio.h>
#include <ctype.h>
#include "log.h"


void wraplog( const char *fmt, ... )
{
	va_list args;

	va_start( args, fmt );

#if defined( SYSLOG )
	vsyslog( LOG_INFO, fmt, args );
#else
	if ( 0 )
	{
		struct timeval t;

		gettimeofday( &t, NULL );
		fprintf( stderr, "%ld.%ld :: ", (long int) t.tv_sec, (long int) t.tv_usec );
	}

	vfprintf( stderr, fmt, args );
	fprintf( stderr, "\n\r" );
#endif

	va_end( args );

	return;
}


void wraperror( const char *fmt, ... )
{
	char buf[ 8192 ];
	va_list args;

	va_start( args, fmt );
	vsprintf( buf, fmt, args );
	va_end( args );

#if defined( SYSLOG )
	syslog( LOG_INFO, "%s: %m", buf );
#else
	perror( buf );
#endif

	return;
}


void strdump( const char *c, size_t length )
{
	size_t i;
		
	for ( i = 0; i < length; i++ )
	{
		if ( *c == '\n' )
			fprintf( stderr, "[0x%02hX]%c", (unsigned char) *c, *c );

		else if ( *c > 0 && ( isgraph( (unsigned char) *c ) || *c == ' ' ) )
			fprintf( stderr, "%c", *c );

		else
			fprintf( stderr, "[0x%02hX]", (unsigned char) *c );

		c++;
	}
	fprintf( stderr, "\n" );

	return;
}
