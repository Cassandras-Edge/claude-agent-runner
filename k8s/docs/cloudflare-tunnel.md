# Cloudflare Tunnel Setup

Expose the orchestrator API and WebSocket over the internet via Cloudflare Tunnel, without opening any ports or configuring ingress.

## How it works

A `cloudflared` sidecar runs alongside the orchestrator in the same pod. Since containers in a pod share `localhost`, cloudflared forwards external traffic to the orchestrator's HTTP (8080) and WebSocket (8081) ports. No k8s Service, Ingress, or LoadBalancer changes needed.

```
Internet → Cloudflare Edge → cloudflared sidecar → localhost:8080 (API)
                                                  → localhost:8081 (WS)
```

## Prerequisites

- A Cloudflare account (free tier works)
- A domain added to Cloudflare (even a free one)
- `cloudflared` CLI installed locally (for initial setup only)

```bash
# macOS
brew install cloudflared

# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
```

## Step 1: Create the tunnel

```bash
# Login to Cloudflare (opens browser)
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create claude-runner

# Note the tunnel ID (e.g. a1b2c3d4-e5f6-...)
```

## Step 2: Configure DNS routes

Point your subdomains to the tunnel:

```bash
# API endpoint
cloudflared tunnel route dns claude-runner api.claude.yourdomain.com

# WebSocket endpoint (can be same or different subdomain)
cloudflared tunnel route dns claude-runner ws.claude.yourdomain.com
```

## Step 3: Create tunnel config

Go to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) → Networks → Tunnels → your tunnel → Configure.

Add two public hostname entries:

| Public hostname | Service |
|---|---|
| `api.claude.yourdomain.com` | `http://localhost:8080` |
| `ws.claude.yourdomain.com` | `http://localhost:8081` |

For the WebSocket hostname, enable **WebSockets** under the hostname's settings (usually auto-detected).

Alternatively, if you want both on the same domain, use path-based routing:

| Public hostname | Path | Service |
|---|---|---|
| `claude.yourdomain.com` | `/ws` | `http://localhost:8081` |
| `claude.yourdomain.com` | `/*` | `http://localhost:8080` |

## Step 4: Get the tunnel token

In the Cloudflare dashboard, go to your tunnel → Overview → copy the **tunnel token**. It looks like a long base64 string.

## Step 5: Create the k8s secret

```bash
kubectl create secret generic cloudflare-tunnel \
  -n infra \
  --from-literal=token="YOUR_TUNNEL_TOKEN_HERE"
```

## Step 6: Enable the sidecar

Edit `k8s/orchestrator-deployment.yaml` and uncomment the cloudflared sidecar section:

```yaml
        - name: cloudflared
          image: cloudflare/cloudflared:2024.12.2
          args: ["tunnel", "run"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflare-tunnel
                  key: token
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
```

Apply the changes:

```bash
kubectl apply -f k8s/orchestrator-deployment.yaml
```

## Step 7: Verify

```bash
# Check the pod has both containers running
kubectl -n production get pods
# Should show 2/2 Ready

# Test the external endpoint
curl https://api.claude.yourdomain.com/health

# Test WebSocket (using websocat or similar)
websocat wss://ws.claude.yourdomain.com/ws
```

## Cloudflare Access (optional)

To restrict who can reach the API, add a [Cloudflare Access policy](https://developers.cloudflare.com/cloudflare-one/policies/access/):

1. Go to Zero Trust dashboard → Access → Applications
2. Add application → Self-hosted
3. Set the domain to `api.claude.yourdomain.com`
4. Add a policy (e.g. email allowlist, GitHub org, etc.)

This adds authentication at the Cloudflare edge before traffic reaches your cluster. The orchestrator's own API key auth (`X-API-Key`) still applies as a second layer.

## Troubleshooting

**cloudflared container keeps restarting:**
- Check the secret exists: `kubectl get secret cloudflare-tunnel -n production`
- Check logs: `kubectl logs <pod> -c cloudflared -n production`
- Common issue: wrong tunnel token (copy the full token, not the tunnel ID)

**WebSocket connections fail:**
- Ensure WebSockets are enabled for the hostname in Cloudflare dashboard
- Check that the WS hostname points to port 8081, not 8080

**Tunnel shows "inactive" in dashboard:**
- The pod might not be running yet. Check: `kubectl get pods -n production`
- The tunnel token might be for a different tunnel

## Updating cloudflared

To update the cloudflared image version, edit the `image:` tag in the deployment and apply:

```bash
# Check latest version at https://github.com/cloudflare/cloudflared/releases
kubectl -n production set image deployment/claude-orchestrator cloudflared=cloudflare/cloudflared:NEW_VERSION
```
