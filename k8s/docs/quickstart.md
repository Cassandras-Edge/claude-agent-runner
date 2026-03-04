# k8s Quickstart (local k3d)

Get the orchestrator + runner + monitoring stack running locally in under 5 minutes.

## Prerequisites

```bash
brew install k3d kubectl
```

## 1. Create cluster

```bash
k3d cluster create claude-runner
```

## 2. Build and load images

```bash
# From the repo root
docker build -t claude-orchestrator:latest -f packages/orchestrator/Dockerfile .
docker build -t claude-runner:latest -f packages/runner/Dockerfile .

k3d image import claude-orchestrator:latest claude-runner:latest -c claude-runner
```

## 3. Create namespace and secrets

```bash
kubectl apply -f k8s/namespace.yaml

# Real OAuth token (required)
kubectl create secret generic claude-tokens \
  -n claude-runner \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"

# Placeholder secrets (optional — fill in if using vaults/git)
kubectl create secret generic obsidian-auth -n claude-runner \
  --from-literal=OBSIDIAN_AUTH_TOKEN="" \
  --from-literal=OBSIDIAN_E2EE_PASSWORD=""

kubectl create secret generic git-tokens -n claude-runner \
  --from-literal=GIT_TOKEN="" \
  --from-literal=GITHUB_TOKEN=""
```

## 4. Fix PVC for local-path (single-node)

The default sessions PVC uses `ReadWriteOnce` which works with k3d's `local-path` provisioner. If you changed it to `ReadWriteMany`, change it back:

```bash
kubectl apply -f k8s/pvc-sessions.yaml
kubectl apply -f k8s/pvc-orchestrator.yaml
```

## 5. Deploy orchestrator

```bash
kubectl apply -f k8s/orchestrator-rbac.yaml
kubectl apply -f k8s/orchestrator-service.yaml

# Apply deployment with imagePullPolicy override for local images
cat k8s/orchestrator-deployment.yaml | \
  sed 's/image: claude-orchestrator:latest/image: claude-orchestrator:latest\n          imagePullPolicy: Never/' | \
  kubectl apply -f -

# Set image pull policy for runner pods
kubectl -n claude-runner set env deployment/claude-orchestrator RUNNER_IMAGE_PULL_POLICY=Never

# Wait for ready
kubectl -n claude-runner rollout status deployment/claude-orchestrator --timeout=60s
```

## 6. Test it

```bash
# Port-forward
kubectl -n claude-runner port-forward svc/claude-orchestrator 9080:8080 &

# Health check
curl localhost:9080/health

# Create a session
curl -X POST localhost:9080/sessions \
  -H 'Content-Type: application/json' \
  -d '{"message": "say hello"}'

# Check pods
kubectl -n claude-runner get pods

# Check metrics
curl localhost:9080/metrics | grep sessions_created
```

## 7. Deploy monitoring (optional)

```bash
kubectl apply -k k8s/monitoring/

# Wait for pods
kubectl -n monitoring get pods -w

# Port-forward Grafana
kubectl -n monitoring port-forward svc/grafana 3000:3000 &

# Open http://localhost:3000 (admin/admin)
# Datasources pre-configured: VictoriaMetrics + VictoriaLogs
```

## Useful commands

```bash
# Orchestrator logs
kubectl -n claude-runner logs deploy/claude-orchestrator -f

# Runner pod logs
kubectl -n claude-runner logs <pod-name> -f

# All pods
kubectl -n claude-runner get pods
kubectl -n monitoring get pods

# Events (scheduling failures, image pulls)
kubectl -n claude-runner get events --sort-by=.lastTimestamp

# Query VictoriaMetrics
kubectl -n monitoring port-forward svc/victoria-metrics 8428:8428 &
curl 'localhost:8428/api/v1/query?query=sessions_created_total'

# Cleanup
k3d cluster delete claude-runner
```

## Tenants (optional)

Enable multi-tenancy by setting env vars on the orchestrator:

```bash
kubectl -n claude-runner set env deployment/claude-orchestrator \
  ENABLE_TENANTS=true \
  ADMIN_API_KEY=your-admin-secret-here

# Create a tenant
curl -X POST localhost:9080/tenants \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: your-admin-secret-here' \
  -d '{"id": "my-project", "name": "My Project"}'
# Returns: { "api_key": "..." } — save this, shown once

# Use the tenant API key for all session operations
curl -X POST localhost:9080/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <tenant-api-key>' \
  -d '{"message": "hello"}'
```
