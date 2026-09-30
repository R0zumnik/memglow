---
title: reference-incident-log
theme: knowledge
subtheme: ops
description: "Incident log of the home lab and client staging servers since 2025 — grew too long, a good candidate to split"
---

# Incident log

Every incident met on the home lab and on the client staging servers, oldest first. One entry per
incident: what happened, why, what was changed. Kept in one note since the start, which is why it
is long. See also [[project-home-lab]], [[reference-docker-pitfalls]], [[reference-backups]] and
[[knowledge-reverse-proxy]].

## 2025 Q1

**2025-01-02 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 70 minutes. Checklist updated.

**2025-01-07 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 30 minutes. No repeat since.

**2025-01-10 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 28 minutes. Restore test planned for next month.

**2025-01-17 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 141 minutes. Restore test planned for next month.

**2025-02-02 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 167 minutes. Alert added to the weekly review.

**2025-02-13 — Git server.** Symptom: clocks drifted by several minutes and tokens were rejected. Cause: the time sync service was disabled by a system update. Fix: re-enabled time sync and added a drift alert. Time to fix: 69 minutes. Alert added to the weekly review.

**2025-02-17 — Wi-Fi.** Symptom: a renamed service stayed unreachable from some devices for a day. Cause: a DNS cache kept an old address for a whole day. Fix: lowered the cache time and documented how to flush it. Time to fix: 130 minutes. Alert added to the weekly review.

**2025-02-27 — Storefront staging.** Symptom: the service answered 502 for a few minutes after each deploy. Cause: the health check used a URL that required authentication. Fix: pointed the health check at a public, cheap endpoint. Time to fix: 158 minutes. Documented in [[reference-docker-pitfalls]].

**2025-03-03 — Calendar sync.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 179 minutes. No repeat since.

**2025-03-10 — Storefront staging.** Symptom: the service answered 502 for a few minutes after each deploy. Cause: the health check used a URL that required authentication. Fix: pointed the health check at a public, cheap endpoint. Time to fix: 53 minutes. Backup side covered in [[reference-backups]].

**2025-03-13 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 93 minutes. Checklist updated.

**2025-03-22 — Media server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 40 minutes. Restore test planned for next month.

## 2025 Q2

**2025-04-04 — Git server.** Symptom: clocks drifted by several minutes and tokens were rejected. Cause: the time sync service was disabled by a system update. Fix: re-enabled time sync and added a drift alert. Time to fix: 45 minutes. Still watching it for a few weeks.

**2025-04-11 — Git server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 80 minutes. Alert added to the weekly review.

**2025-04-19 — Calendar sync.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 44 minutes. Linked from [[project-home-lab]].

**2025-04-21 — Backups.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 125 minutes. Documented in [[reference-docker-pitfalls]].

**2025-05-09 — Backups.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 55 minutes. Still watching it for a few weeks.

**2025-05-14 — Storefront staging.** Symptom: the service answered 502 for a few minutes after each deploy. Cause: the health check used a URL that required authentication. Fix: pointed the health check at a public, cheap endpoint. Time to fix: 27 minutes. No repeat since.

**2025-05-18 — DNS.** Symptom: a renamed service stayed unreachable from some devices for a day. Cause: a DNS cache kept an old address for a whole day. Fix: lowered the cache time and documented how to flush it. Time to fix: 137 minutes. Linked from [[project-home-lab]].

**2025-05-22 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 49 minutes. Documented in [[reference-docker-pitfalls]].

**2025-06-06 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 22 minutes. Documented in [[reference-docker-pitfalls]].

**2025-06-06 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 105 minutes. Linked from [[project-home-lab]].

**2025-06-08 — DNS.** Symptom: a renamed service stayed unreachable from some devices for a day. Cause: a DNS cache kept an old address for a whole day. Fix: lowered the cache time and documented how to flush it. Time to fix: 136 minutes. No repeat since.

**2025-06-26 — Booking app staging.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 164 minutes. Checklist updated.

## 2025 Q3

**2025-07-08 — Backups.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 104 minutes. Still watching it for a few weeks.

**2025-07-22 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 101 minutes. Restore test planned for next month.

**2025-07-24 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 49 minutes. No repeat since.

**2025-07-26 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 137 minutes. Documented in [[reference-docker-pitfalls]].

**2025-08-11 — Git server.** Symptom: the container restarted in a loop after an image update. Cause: the new image ran as a different user and could not write its data folder. Fix: set the user explicitly and fixed the ownership of the data folder. Time to fix: 29 minutes. Backup side covered in [[reference-backups]].

**2025-08-18 — Password manager.** Symptom: clocks drifted by several minutes and tokens were rejected. Cause: the time sync service was disabled by a system update. Fix: re-enabled time sync and added a drift alert. Time to fix: 109 minutes. Checklist updated.

**2025-08-25 — Wi-Fi.** Symptom: a renamed service stayed unreachable from some devices for a day. Cause: a DNS cache kept an old address for a whole day. Fix: lowered the cache time and documented how to flush it. Time to fix: 73 minutes. Documented in [[reference-docker-pitfalls]].

**2025-08-27 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 55 minutes. Alert added to the weekly review.

**2025-09-01 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 61 minutes. Restore test planned for next month.

**2025-09-03 — Home automation.** Symptom: sensors stopped reporting for about two hours. Cause: the broker lost its retained configuration after an upgrade. Fix: exported the configuration to a file kept in version control. Time to fix: 105 minutes. Still watching it for a few weeks.

**2025-09-04 — Booking app staging.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 100 minutes. Alert added to the weekly review.

**2025-09-14 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 172 minutes. Linked from [[project-home-lab]].

## 2025 Q4

**2025-10-01 — MQTT broker.** Symptom: sensors stopped reporting for about two hours. Cause: the broker lost its retained configuration after an upgrade. Fix: exported the configuration to a file kept in version control. Time to fix: 158 minutes. No repeat since.

**2025-10-12 — Backups.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 97 minutes. Documented in [[reference-docker-pitfalls]].

**2025-10-14 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 77 minutes. Still watching it for a few weeks.

**2025-10-15 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 175 minutes. Still watching it for a few weeks.

**2025-11-01 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 11 minutes. Checklist updated.

**2025-11-04 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 109 minutes. Linked from [[project-home-lab]].

**2025-11-07 — Git server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 134 minutes. Checklist updated.

**2025-11-26 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 48 minutes. Restore test planned for next month.

**2025-12-01 — Git server.** Symptom: clocks drifted by several minutes and tokens were rejected. Cause: the time sync service was disabled by a system update. Fix: re-enabled time sync and added a drift alert. Time to fix: 104 minutes. Alert added to the weekly review.

**2025-12-04 — Home automation.** Symptom: sensors stopped reporting for about two hours. Cause: the broker lost its retained configuration after an upgrade. Fix: exported the configuration to a file kept in version control. Time to fix: 150 minutes. Still watching it for a few weeks.

**2025-12-05 — Storefront staging.** Symptom: webhooks were delivered twice and created duplicate orders. Cause: the handler was not idempotent and retries were enabled. Fix: stored the event id and ignored duplicates. Time to fix: 79 minutes. Linked from [[project-home-lab]].

**2025-12-25 — Git server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 143 minutes. Alert added to the weekly review.

## 2026 Q1

**2026-01-12 — Storefront staging.** Symptom: webhooks were delivered twice and created duplicate orders. Cause: the handler was not idempotent and retries were enabled. Fix: stored the event id and ignored duplicates. Time to fix: 139 minutes. No repeat since.

**2026-01-15 — Backups.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 67 minutes. Restore test planned for next month.

**2026-01-27 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 85 minutes. Checklist updated.

**2026-01-27 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 21 minutes. Linked from [[project-home-lab]].

**2026-02-08 — Home automation.** Symptom: sensors stopped reporting for about two hours. Cause: the broker lost its retained configuration after an upgrade. Fix: exported the configuration to a file kept in version control. Time to fix: 130 minutes. Restore test planned for next month.

**2026-02-11 — Booking app staging.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 157 minutes. Checklist updated.

**2026-02-14 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 70 minutes. Alert added to the weekly review.

**2026-02-20 — Backups.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 146 minutes. Alert added to the weekly review.

**2026-03-04 — Calendar sync.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 80 minutes. No repeat since.

**2026-03-12 — Storefront staging.** Symptom: webhooks were delivered twice and created duplicate orders. Cause: the handler was not idempotent and retries were enabled. Fix: stored the event id and ignored duplicates. Time to fix: 152 minutes. Alert added to the weekly review.

**2026-03-22 — Password manager.** Symptom: the container restarted in a loop after an image update. Cause: the new image ran as a different user and could not write its data folder. Fix: set the user explicitly and fixed the ownership of the data folder. Time to fix: 23 minutes. Still watching it for a few weeks.

**2026-03-23 — Media server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 111 minutes. Checklist updated.

## 2026 Q2

**2026-04-05 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 64 minutes. Alert added to the weekly review.

**2026-04-07 — Git server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 13 minutes. Alert added to the weekly review.

**2026-04-08 — Git server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 90 minutes. No repeat since.

**2026-04-25 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 143 minutes. Checklist updated.

**2026-05-19 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 133 minutes. Still watching it for a few weeks.

**2026-05-19 — Calendar sync.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 31 minutes. Backup side covered in [[reference-backups]].

**2026-05-24 — Booking app staging.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 32 minutes. No repeat since.

**2026-05-27 — Reverse proxy.** Symptom: live updates stopped reaching the browser behind the proxy. Cause: the proxy buffered server-sent events. Fix: disabled buffering for that route and raised the idle timeout. Time to fix: 153 minutes. Linked from [[project-home-lab]].

**2026-06-05 — Storefront staging.** Symptom: the service answered 502 for a few minutes after each deploy. Cause: the health check used a URL that required authentication. Fix: pointed the health check at a public, cheap endpoint. Time to fix: 54 minutes. Alert added to the weekly review.

**2026-06-07 — Git server.** Symptom: disk usage jumped from 61 % to 94 % overnight. Cause: old log files were never rotated. Fix: added log rotation with a 14-day retention. Time to fix: 54 minutes. Alert added to the weekly review.

**2026-06-10 — Git server.** Symptom: the container restarted in a loop after an image update. Cause: the new image ran as a different user and could not write its data folder. Fix: set the user explicitly and fixed the ownership of the data folder. Time to fix: 16 minutes. Still watching it for a few weeks.

**2026-06-20 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 90 minutes. Backup side covered in [[reference-backups]].

## 2026 Q3

**2026-07-11 — Password manager.** Symptom: the container restarted in a loop after an image update. Cause: the new image ran as a different user and could not write its data folder. Fix: set the user explicitly and fixed the ownership of the data folder. Time to fix: 92 minutes. Restore test planned for next month.

**2026-07-12 — Backups.** Symptom: the nightly job reported success but the snapshot folder was empty. Cause: a bind mount pointed to a path that no longer existed after a rename. Fix: pinned the path in the compose file and added a check that fails loudly. Time to fix: 151 minutes. Alert added to the weekly review.

**2026-07-13 — MQTT broker.** Symptom: sensors stopped reporting for about two hours. Cause: the broker lost its retained configuration after an upgrade. Fix: exported the configuration to a file kept in version control. Time to fix: 14 minutes. Documented in [[reference-docker-pitfalls]].

**2026-07-24 — Home automation.** Symptom: two scheduled jobs failed on the same night. Cause: two jobs started at the same minute and fought over a lock. Fix: spread the schedules and added a lock timeout. Time to fix: 31 minutes. Still watching it for a few weeks.

**2026-08-05 — MQTT broker.** Symptom: retained messages replayed old states at startup. Cause: stale retained messages were never cleared after devices were removed. Fix: cleared the stale topics and added a cleanup step to the device removal checklist. Time to fix: 41 minutes. Linked from [[project-home-lab]].

**2026-08-10 — Storefront staging.** Symptom: the service answered 502 for a few minutes after each deploy. Cause: the health check used a URL that required authentication. Fix: pointed the health check at a public, cheap endpoint. Time to fix: 52 minutes. No repeat since.

**2026-08-14 — Booking app staging.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 99 minutes. Documented in [[reference-docker-pitfalls]].

**2026-08-24 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 43 minutes. No repeat since.

**2026-09-07 — Booking app staging.** Symptom: a recurring event showed up one hour late after the time change. Cause: the time zone was stored as an offset instead of a zone name. Fix: stored zone names everywhere and converted only for display. Time to fix: 38 minutes. Backup side covered in [[reference-backups]].

**2026-09-16 — Storefront staging.** Symptom: the service answered 502 for a few minutes after each deploy. Cause: the health check used a URL that required authentication. Fix: pointed the health check at a public, cheap endpoint. Time to fix: 28 minutes. Still watching it for a few weeks.

**2026-09-26 — Git server.** Symptom: the container restarted in a loop after an image update. Cause: the new image ran as a different user and could not write its data folder. Fix: set the user explicitly and fixed the ownership of the data folder. Time to fix: 129 minutes. Alert added to the weekly review.

**2026-09-27 — Reverse proxy.** Symptom: certificates were not renewed and the browser showed a warning. Cause: the renewal hook ran in a container without network access. Fix: moved the renewal to the host and added an expiry alert at 14 days. Time to fix: 72 minutes. Alert added to the weekly review.
