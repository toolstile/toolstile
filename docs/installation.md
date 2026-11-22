# Installation

Toolstile is the independent-user MCP gateway. Choose the deployment that fits your own infrastructure:

- [Local operation](local-operation.md): `npx toolstile server start` downloads and runs the released executable (macOS on Apple silicon, Linux x64 or arm64); or run the executable yourself, or Node 26 from a source checkout. Persistent embedded PGlite, no external database.
- [Docker Compose](containers.md): a production container with persistent PostgreSQL, external secrets and your HTTPS reverse proxy.
- [Kubernetes](kubernetes.md): the same image with operator-managed PostgreSQL, Secrets and ingress/TLS.

The local executable is published with each release, with a SHA-256 checksum and a build provenance attestation. The container and Kubernetes guides build your own image from a reviewed source checkout; there is no published image. Preserve stable keys and storage. Migrations use the PostgreSQL migration journal and do not convert other database formats.

All packaged server deployments use one application replica. MCP sessions reconnect after restart; PostgreSQL durability does not provide horizontal session forwarding or HA. The [documentation index](README.md) links to account, destination-policy, approval and security guidance.
