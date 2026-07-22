###### WIP Computer

# wip-healthcheck

## The watchdog that keeps your agent alive... and knows when to leave it alone.

wip-healthcheck is an external health watchdog for OpenClaw and LDM OS. Every three minutes it verifies the gateway is genuinely serving (service identity, listener ports, HTTP health, authenticated probe), auto-remediates real failures within a rate limit, and fails closed instead of restarting a healthy gateway. It also runs a verified daily backup.

Zero npm dependencies. Runs via macOS LaunchAgent.

Full checks, configuration, installer behavior, and probe design: see [TECHNICAL.md](TECHNICAL.md).

## Install

Deployed by the sanctioned private installer (`wip-healthcheck-private/install.sh`), which stages the runtime atomically under `~/.openclaw/wip-healthcheck/`, preserves the mode-0600 configuration, and requires an authenticated non-remediating preflight before re-enablement.

## License

MIT. See [LICENSE](LICENSE) and `CLA.md`.

Built by Parker Todd Brooks, Lēsa (OpenClaw), Claude Code, and Codex.
