# Alibaba Cloud Function Deployment

This directory contains the configuration files for deploying the XMCL Web API to Alibaba Cloud Function using Deno custom runtime.

## Files

- **bootstrap** - The entry point script for Alibaba Cloud Function custom runtime. This script installs Deno if needed and starts the application.

## Deployment

### Prerequisites

1. Install Serverless Devs CLI:
   ```bash
   npm install -g @serverless-devs/s
   ```

2. Configure your Alibaba Cloud credentials:
   ```bash
   s config add
   ```

### Manual Deployment

From the root directory of the project:

```bash
s deploy --use-local -y
```

### Automatic Deployment

The GitHub Actions workflow in `.github/workflows/deploy-aliyun.yml` automatically deploys to Alibaba Cloud Function when changes are pushed to the main branch.

Required GitHub secrets:
- `ALIYUN_ACCOUNT_ID`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- Environment variables (MONGO_CONNECION_STRING, GITHUB_PAT, etc.)

## Custom Runtime

The custom runtime uses the `bootstrap` script which:
1. Checks if Deno is installed, and installs it if needed
2. Starts the Deno application with necessary permissions (`--allow-net`, `--allow-read`, `--allow-env`)

The application listens on port 8080, which is configured in the `s.yaml` file.
