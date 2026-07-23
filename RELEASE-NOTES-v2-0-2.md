# wip-healthcheck v2.0.2

## Fixed

- Include `/usr/sbin` and `/sbin` in the generated LaunchAgent path so scheduled `lsof` identity checks resolve on macOS.
- Audit every scheduled executable before unloading or replacing the watchdog service.
- Run the authenticated re-enable preflight under the exact environment written to the LaunchAgent plist.

## Validation

- Installer regression coverage verifies scheduled executable resolution, gateway identity inspection, fail-closed behavior when `lsof` is unavailable, and rejection when an interactive shell would hide a broken scheduled environment.
