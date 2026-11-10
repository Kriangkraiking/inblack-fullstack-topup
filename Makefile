# Every target delegates to scripts/ci/test-all.mjs, which also runs without make:
#   node scripts/ci/test-all.mjs [step ...]   or   pnpm test:all
# INVARIANTS=s1a,s2b,s3,s4 limits the invariant audit in `make e2e` (default: all scenarios).
RUN := node scripts/ci/test-all.mjs
INV := $(if $(INVARIANTS),--invariants $(INVARIANTS),)

.PHONY: test lint typecheck unit integration e2e up down

test:
	$(RUN) $(INV)

lint typecheck unit integration up down:
	$(RUN) $@

e2e:
	$(RUN) e2e $(INV)
