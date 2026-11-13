# Documentation

## Contributing and maintaining

- [Contributing](../CONTRIBUTING.md): contributor entry point and commit policy
- [Development](development.md): task lifecycle, interactive server and ownership/recovery
- [CI](ci.md): canonical validation gates and workflow policy
- [Verification](verification.md): fixture behavior, coverage and compatibility limits
- [Local environment policy](local-environment.md): generic lifecycle adapter and environment helper contracts
- [Architecture](architecture.md): storage, authority and runtime boundaries
- [Packages](packages.md): source export contracts; [auth](../packages/auth/README.md) and [gateway](../packages/gateway/README.md) own their detailed APIs
- [Design](design.md): interface and interaction rules; [artwork](artwork.md) owns asset provenance
- [Product scope](product.md): independent-user permissions and supported interactions
- [Connector catalog](connector-catalog.md): catalog, connection and operator OAuth contracts

## Operating an instance

- [Installation](installation.md), [local operation and recovery](local-operation.md), [Docker Compose](containers.md), [Kubernetes](kubernetes.md)
- [Approvals](approvals.md), [tool review](tool-review.md), [telemetry and debug capture](telemetry.md)
- [Security reporting](../SECURITY.md)

Operator procedures, package/API contracts and asset provenance retain their own canonical documents. Development lifecycle automation is separate from running a persistent instance.
