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
