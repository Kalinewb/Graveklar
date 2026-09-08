# systemd user units for the production host

Production runs as the user service `graveklar.service` (see DEPLOYMENT.md).
These files are the timers the audit found missing or mis-anchored on
2026-09-06 (findings R-1b and R-4). Install them with:

```bash
cp deploy/systemd/user/graveklar-backup.service deploy/systemd/user/graveklar-backup.timer deploy/systemd/user/graveklar-cleanup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now graveklar-backup.timer
systemctl --user restart graveklar-cleanup.timer
systemctl --user list-timers --all | grep graveklar
```

`graveklar-cleanup.service` and `graveklar-reminders.{service,timer}` already
exist on the host and are unchanged; only the cleanup *timer* is replaced so
it runs on a wall-clock schedule.
