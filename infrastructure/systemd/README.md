# Systemd Units

`nexus-browser.service` is versioned as-is: it only uses standard systemd specifiers (`%h`, `%t`), making it portable across systems without modification.

`nexus-mission-engine.service` is generated dynamically. It previously contained machine-specific absolute paths, making it brittle across installations and causing silent failures when moving directories.

It is now **generated** dynamically based on the detected installation root:

```sh
nexus setup          # writes ~/.config/systemd/user/nexus-mission-engine.service
systemctl --user daemon-reload
nexus start
```

The template is defined in `packages/cli/src/systemd.ts`. `nexus doctor` validates that installed unit paths match the current repository location, preventing silent path mismatch failures.
