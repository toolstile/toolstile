# Kubernetes

Use the same self-built [container image](containers.md) with a PostgreSQL database you manage. The maintained package is plain manifests with a Kustomize base, rather than a Helm chart: there is one application Deployment, one Service, an explicit migration Job and an optional Ingress. No operator, database chart, Redis, cert-manager, service mesh or backup controller is required. Kustomize lets operators own image, namespace, origin, resource and ingress customizations without maintaining a templating language or installing cluster controllers.

The supported topology is **one application replica**, with `Recreate` replacement. MCP sessions live in that process. Replacements interrupt sessions and require clients to initialize again. This package does not provide horizontal live-session forwarding, zero-downtime upgrades or HA. Do not add an HPA or raise replicas. PostgreSQL durability and availability are the database operator's responsibility.

## Prepare

Use a reviewed Kubernetes release supported by your infrastructure team and `kubectl` with Kustomize support. Build an image from the reviewed source. Push it to a registry your cluster can pull from. Pin the same immutable image digest or unique revision tag in the Deployment and migration Job. Configure `imagePullSecrets` in your overlay if your registry needs them. The local `toolstile:local` tag in the base is a development placeholder, not a published image.

Prepare PostgreSQL 17 (the tested packaging version) with a dedicated database and role allowed to create/alter the application's tables. Use a verified TLS connection when the database is outside a trusted local network. For a private CA, mount its certificate read-only and configure PostgreSQL's connection verification appropriately, for example a `sslmode=verify-full` URL plus a CA file supported by the Node PostgreSQL client. Do not disable certificate validation. Retain database credentials and the two application keys across upgrades. Use a Kubernetes Secret or your existing secret-management integration; no secret controller is installed here.

Create a namespace and Secret in the intended cluster context deliberately. The three input files have the same names as Compose (`database_url`, `auth_secret`, `encryption_key`); generate the application keys with `openssl rand -hex 32`. The database URL must name the external Postgres service and encode reserved password characters. Never commit the secret files or generated Secret YAML.

```sh
kubectl --context YOUR_CONTEXT create namespace toolstile
kubectl --context YOUR_CONTEXT -n toolstile create secret generic toolstile-secrets \
  --from-file=database_url=/secure/toolstile/database_url \
  --from-file=auth_secret=/secure/toolstile/auth_secret \
  --from-file=encryption_key=/secure/toolstile/encryption_key
```

Restrict Secret access through RBAC and enable your cluster's encryption at rest. Secret updates do not automatically restart Pods or rotate encrypted application data. Retain auth/encryption values; credential rotation requires a deliberate compatible procedure. Network-policy rules depend on your CNI, DNS and upstream destination needs: permit ingress only from your ingress controller, DNS and required outbound MCP/OAuth/catalog/database access. The app's private-network destination policy still applies. No permissive cluster role, host networking or mounted service-account token is used.

Create an operator-owned overlay, for example in ignored `deploy/local/production/`, referencing `../../kubernetes`. Set `namespace: toolstile`, override the `toolstile-config` generator's `BETTER_AUTH_URL` with `behavior: merge`, and set the image. Render with `kubectl kustomize deploy/local/production` and inspect every resource before applying. The ConfigMap name hash restarts the Deployment when origin configuration changes. Origin changes also affect OAuth registrations and clients, so keep it stable.

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: toolstile
resources:
  - ../../kubernetes
configMapGenerator:
  - name: toolstile-config
    behavior: merge
    literals:
      - BETTER_AUTH_URL=https://tools.example.com
images:
  - name: toolstile
    newName: registry.example.com/private/toolstile
    newTag: reviewed-revision
```

The app writes no persistent local files when using PostgreSQL. No application PVC is needed. `/tmp` uses a bounded `emptyDir`; Secret files are read-only and group-readable to the fixed non-root UID/GID 1000. The root filesystem is read-only, capabilities are dropped and privilege escalation is disabled. Resource requests/limits are starting values, not a capacity guarantee; measure your workload and adjust in the overlay. `/health` is database/schema readiness, `/live` is process liveness; the startup probe allows up to five minutes for startup, subject to your migration duration and database availability. Do not tie liveness to database health.

## Install and upgrade

1. Retain the previous immutable image and a verified manual database/key backup. Pause clients. For an upgrade, scale the existing Deployment to zero and wait for its old Pods to terminate. A migration Job must not overlap an old app against an incompatible schema. The default `Recreate` strategy alone does not order a separate Job.
2. Render `deploy/kubernetes/migrate.yaml` into an operator-owned release directory and replace its image with the **same** reviewed image selected in the app overlay. Delete the completed previous `toolstile-migrate` Job before creating the next one; never delete a running Job to bypass a lock. Apply it in namespace `toolstile` and wait for completion:

   ```sh
   kubectl --context YOUR_CONTEXT -n toolstile apply -f /your/release/migrate.yaml
   kubectl --context YOUR_CONTEXT -n toolstile wait --for=condition=complete job/toolstile-migrate --timeout=300s
   kubectl --context YOUR_CONTEXT -n toolstile logs job/toolstile-migrate
   ```

   The Job has no automatic retry. Diagnose failures and rerun deliberately; migrations are transactional and advisory-locked, with immutable applied hashes. Do not start the app after failure. The app's `serve` command repeats this migration check on every startup, including Pod rescheduling.
3. Apply the reviewed overlay, then wait for rollout and readiness:

   ```sh
   kubectl --context YOUR_CONTEXT apply -k deploy/local/production
   kubectl --context YOUR_CONTEXT -n toolstile rollout status deployment/toolstile --timeout=300s
   ```

4. Create an invitation with `kubectl --context YOUR_CONTEXT -n toolstile exec deploy/toolstile -- /app/entrypoint.sh bootstrap you@example.com`. Register through the private link. Grant administration using the same command with `operator you@example.com`. Do not run bootstrap automatically or copy its output into shared logs.
5. Verify HTTPS origin, password login, MCP initialize/list/call, reconnect and any upstream provider callbacks before reopening client traffic. Keep invitation/token output private.

The Pod receives SIGTERM on termination, closes admission and streams and closes runtime resources within its bounded lifecycle; termination grace is 35 seconds. Kubernetes endpoint removal and ingress propagation can race with termination, so callers must handle interrupted connections. Unknown outcomes of interrupted non-idempotent tools require operator review. Use the [container recovery runbook](containers.md) for compatible-image rollback or isolated database restore; `kubectl rollout undo` cannot undo a schema migration.

## Ingress and TLS

`deploy/kubernetes/ingress.example.yaml` is optional and deliberately outside the base. Select your installed ingress class, stable hostname and existing TLS Secret. Arrange certificates using your own infrastructure. The same HTTPS origin serves the app and `/mcp`; do not split MCP onto another hostname. Add controller-specific settings for long SSE timeouts and disabled response buffering/caching. Preserve authorization, cookies, MCP headers, methods and query bytes as described in [proxy guidance](containers.md#https-and-reverse-proxy). There is no universal Ingress annotation for streaming; validate with your actual controller. The Service remains ClusterIP and these manifests provision no LoadBalancer.

## Backup and recovery

Use your database team's **manual operator-managed** `pg_dump -Fc` and `pg_restore --exit-on-error` procedure, with tools matching the server major version and verified TLS. Pause the app for an explicit recovery point. Store database backup, exact image revision, origin and matching auth/encryption secrets together in encrypted restricted storage. This package creates no CronJob, scheduled backup, remote bucket or managed backup service.

Rehearse restore into a new isolated database and namespace, keeping existing storage untouched. Supply matching secrets, the compatible image and an isolated hostname/port. Restore into an empty database before migration/startup, validate login and MCP, and prevent unintended external tool calls or email. On actual recovery, stop the old app before routing the original origin to the replacement, and account for all writes after the recovery point. Preserve failed storage for investigation. Database major upgrades are a separate database operation, not a manifest image edit.
