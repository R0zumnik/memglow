---
title: knowledge-docker-networking
theme: knowledge
subtheme: web
description: "Docker networking: bridge networks, published ports, container DNS names"
---

# docker networking

Docker networking: bridge networks, published ports, container DNS names.

## Notes
- Containers on the same user-defined network reach each other by service name.
- Publish only what the reverse proxy needs; keep databases internal.
- See also: [[reference-docker-pitfalls]], [[knowledge-reverse-proxy]].
