# TrustForge Human Decisions

The following decisions remain human-only and must not be automated by agents:

- [ ] create a new dedicated wallet
- [ ] fund the wallet with a controlled minimum balance
- [ ] configure `BUYER_PRIVATE_KEY` locally without committing it
- [ ] authorize MVP-T0C with a 0.005 USDC total spend cap
- [ ] verify the transaction on-chain after MVP-T0C
- [ ] decide whether to create a private GitHub backup
- [ ] decide whether to publish publicly only after T0C
- [ ] review commercial and legal policy before publishing public scores

## T0C arming (set only for the duration of an authorized paid run)

The `fast-track-e2e` run confirmed all four are currently **unset**
(`HUMAN_GATE_T0C_NOT_READY`). The bootstrap registry, contracts, evaluator, and
score pipeline are already in place, so the paid run is short once these are set:

- [ ] `TRUSTFORGE_AUTHORIZE_T0C=YES_I_AUTHORIZE_ONE_EXTERNAL_PAYMENT`
- [ ] `TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED=YES_I_AUTHORIZE_ONE_PAYMENT`
- [ ] `TRUSTFORGE_T0C_RUN_ID=<unique id>`
- [ ] `BUYER_PRIVATE_KEY` configured via the secure loader (never committed)
