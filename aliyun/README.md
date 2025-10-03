# Alibaba Cloud Function Deployment

This directory contains the configuration files for deploying the XMCL Web API to Alibaba Cloud Function using a compiled Deno binary.

## Files

- **bootstrap** - The entry point script for Alibaba Cloud Function custom runtime. This script runs the pre-compiled Deno binary.
- **xmcl-api** - The compiled Deno binary (generated during deployment, not committed to git)

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

3. Install Deno (for local compilation):
   ```bash
   curl -fsSL https://deno.land/install.sh | sh
   ```

### Manual Deployment

From the root directory of the project:

1. Compile the Deno application:
   ```bash
   deno compile --allow-net --allow-read --allow-env \
     --output aliyun/xmcl-api \
     index.ts
   ```

2. Deploy to Alibaba Cloud:
   ```bash
   s deploy --use-local -y
   ```

### Automatic Deployment

The GitHub Actions workflow in `.github/workflows/deploy-aliyun.yml` automatically compiles the binary and deploys to Alibaba Cloud Function when changes are pushed to the main branch.

Required GitHub secrets:
- `ALIYUN_ACCOUNT_ID`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- Environment variables (MONGO_CONNECION_STRING, GITHUB_PAT, etc.)

## How It Works

The custom runtime uses a compiled Deno binary:
1. During deployment, `deno compile` creates a standalone executable from `index.ts`
2. The binary is packaged with the bootstrap script
3. The bootstrap script simply executes the binary when the function is invoked
4. The binary includes all dependencies and runs without requiring Deno to be installed

The application listens on port 8080, which is configured in the `s.yaml` file.

## Benefits of Compiled Binary

- **Faster cold starts** - No need to install Deno at runtime
- **Smaller deployment package** - Only the binary and bootstrap script are deployed
- **Better performance** - Pre-compiled code executes faster
- **Simpler runtime** - No external dependencies needed
