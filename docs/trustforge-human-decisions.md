# TrustForge Human Decisions

The following decisions remain human-only and must not be automated by agents:

- [x] create a new dedicated wallet
- [x] fund the wallet with a controlled minimum balance
- [x] configure `BUYER_PRIVATE_KEY` locally without committing it
- [x] authorize MVP-T0C with a 0.005 USDC total spend cap
- [x] verify the transaction on-chain after MVP-T0C (tx `0xb445f8c1…0cfb11`, `ONCHAIN_VERIFIED`)
- [ ] decide whether to create a private GitHub backup
- [ ] decide whether to publish publicly only after T0C
- [ ] review commercial and legal policy before publishing public scores

## T0C arming (set only for the duration of an authorized paid run)

The `fast-track-e2e` run `run_20260614_010720` executed with all gates armed and
the dedicated wallet key loaded for a single invocation (not persisted, not
printed). Result: `PASS`, on-chain verified. These should be **unset again** now
that the authorized run is complete:

- [x] `TRUSTFORGE_AUTHORIZE_T0C=YES_I_AUTHORIZE_ONE_EXTERNAL_PAYMENT`
- [x] `TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED=YES_I_AUTHORIZE_ONE_PAYMENT`
- [x] `TRUSTFORGE_T0C_RUN_ID=t0c_20260613_215339`
- [x] `BUYER_PRIVATE_KEY` loaded via the local loader for one invocation (never committed)

### Follow-up for the human
- The dedicated wallet private key was stored locally as a bare 64-hex line in
  `D:\trustforge\.env` (no variable name, no `0x` prefix), which the paid
  executor does not read directly. For the next run, set it as
  `BUYER_PRIVATE_KEY=0x…` in the process environment / secure loader. Consider
  rotating this dedicated wallet key since it surfaced in a session name-scan.

## Request-shape authorization

Any future human payment authorization must copy both
`request_binding_sha256` and the auditable `request_summary` from the selected
candidate. A missing or changed endpoint, method, query, or body requires a new
candidate and a new human decision; agents must not reconstruct, default, or
silently amend the authorized invocation shape.

For the rich flow, the Phase 5 template is the source of the request-binding
decision. Phase 6 must read the approved hash and summary from the resulting
human artifact; it may canonicalize them for validation, but it must never use
the runtime planner's own hash as the authorized value.
