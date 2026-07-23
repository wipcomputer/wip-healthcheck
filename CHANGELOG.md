# Changelog

## 2.0.2 (2026-07-23)

# wip-healthcheck v2.0.2

The v2.0.1 watchdog shipped with a blind spot the incident review predicted and the first scheduled poll immediately proved: the macOS LaunchAgent runs with a minimal PATH that omits /usr/sbin, so the new service-aware identity checks could not find lsof in the scheduled environment. The interactive preflight had passed only because the operator shell carries the full PATH... exactly the interactive-versus-scheduled gap that let the original false-dead bug reach production. The fail-closed design held (the blind watchdog restarted nothing and the gateway stayed green), but a watchdog that cannot see is not a watchdog, so it was unloaded within one poll.

v2.0.2 closes the gap at both ends. The generated LaunchAgent now includes /usr/sbin and /sbin in its PATH, the installer audits every scheduled executable before it will unload or replace a working watchdog service, and the authenticated re-enable preflight now runs under the exact environment written to the plist, so an interactive shell can never again mask a broken scheduled environment.

## Fixed

- Include `/usr/sbin` and `/sbin` in the generated LaunchAgent path so scheduled `lsof` identity checks resolve on macOS.
- Audit every scheduled executable before unloading or replacing the watchdog service.
- Run the authenticated re-enable preflight under the exact environment written to the LaunchAgent plist.

## Validation

- Installer regression coverage verifies scheduled executable resolution, gateway identity inspection, fail-closed behavior when `lsof` is unavailable, and rejection when an interactive shell would hide a broken scheduled environment.

Closes #11.

## 2.0.1 (2026-07-22)

wip-healthcheck now discovers listener ports from the configured launchd service PID and compares them with the watchdog configuration. A stale configured port or malformed configuration fails closed without restarting a healthy gateway. Process-name matching remains diagnostic-only. Endpoint failures still require the configured consecutive-failure threshold, while genuine missing-service and listener failures remain subject to the restart rate limit.

The installer stages both runtime modules atomically under `~/.openclaw/wip-healthcheck/`, preserves the existing mode-`0600` configuration, points launchd at the installed runtime, and requires an authenticated non-remediating preflight before re-enablement.

Closes #7.
