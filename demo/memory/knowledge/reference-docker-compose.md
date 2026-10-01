---
title: reference-docker-compose
theme: knowledge
subtheme: tools
description: "Docker Compose habits: one file per service stack, env files, restart policies"
---

# docker compose

Docker Compose habits: one file per service stack, env files, restart policies.

## Notes
- Pin image versions; `latest` broke the media server twice.
- Healthchecks before `depends_on`, never sleep loops.
- See also: [[reference-docker-pitfalls]], [[knowledge-docker-networking]].
