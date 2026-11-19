# Installation

Toolstile is the independent-user MCP gateway. Choose the deployment that fits your own infrastructure:

- [Local operation](local-operation.md): one executable, or Node 26 from a source checkout, with persistent embedded PGlite and no external database.
- [Docker Compose](containers.md): a production container with persistent PostgreSQL, external secrets and your HTTPS reverse proxy.
- [Kubernetes](kubernetes.md): the same image with operator-managed PostgreSQL, Secrets and ingress/TLS.

Build from a reviewed source checkout; these guides build your own image or output rather than installing a prebuilt package. Preserve stable keys and storage. Migrations use the PostgreSQL migration journal and do not convert other database formats.

All packaged server deployments use one application replica. MCP sessions reconnect after restart; PostgreSQL durability does not provide horizontal session forwarding or HA. The [documentation index](README.md) links to account, destination-policy, approval and security guidance.
