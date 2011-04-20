RM      = rm -f
CC		= gcc
WARN	= -Wall $(WARN2)
C_FLAGS	= -g3 -O0
O_FILES = md5.o ini.o log.o WhiteLantern.o

WhiteLantern: $(O_FILES)
	@echo "[RM   ] WhiteLantern"
	@$(RM) WhiteLantern
	@echo "[CC -o] WhiteLantern"
	@$(CC) $(C_FLAGS) $(WARN) -o WhiteLantern $(O_FILES)

.c.o:
	@echo "[CC -c] $@"
	@$(CC) -c $(C_FLAGS) $(WARN) $< -o$@

warn:
	make WARN2="-pedantic -Wchar-subscripts -Wcomment -Wformat -Wformat-nonliteral -Wformat-security -Wimplicit-int -Werror-implicit-function-declaration -Wmain -Wmissing-braces -Wparentheses -Wsequence-point -Wreturn-type -Wswitch -Wtrigraphs -Wunused -Wuninitialized -Wunknown-pragmas -W -Wfloat-equal -Wdeclaration-after-statement -Wundef -Wendif-labels -Wshadow -Wpointer-arith -Wbad-function-cast -Wcast-qual -Wcast-align -Wwrite-strings -Wconversion -Wsign-compare -Waggregate-return -Wstrict-prototypes -Wmissing-prototypes -Wmissing-declarations -Wmissing-noreturn -Wmissing-format-attribute -Wredundant-decls -Wnested-externs -Wunreachable-code"

standard:
	make WARN2="-ansi -D_XOPEN_SOURCE=520 -pedantic"

war:
	@echo I can\'t do that.

clean:
	$(RM) *.o core core.* *~ *.bak
