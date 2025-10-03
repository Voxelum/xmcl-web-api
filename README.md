# XMCL Web API

This repository contains the server-side code for the X-Minecraft Launcher (XMCL) web API. It provides various backend services that support the launcher functionality.

## Overview

The XMCL Web API serves multiple functions:
- Provides launcher update notifications and release information
- Manages real-time communication for multiplayer sessions
- Handles translations for mod descriptions and UI elements
- Offers WebRTC services for peer-to-peer connections
- Supports authentication with various services

## Architecture

The API is implemented in multiple ways to ensure global availability and reliability:

1. **Primary Service (Deno)** - Hosted on Deno Deploy
   - Entry point: `index.ts`
   - Global availability outside mainland China
   - Uses MongoDB for data storage

2. **Backup Service (Azure Functions)** - Written in TypeScript
   - Entry point: `azure/index.ts`
   - Uses the Azure Functions JavaScript/TypeScript runtime
   - Provides fallback capabilities if the primary service is unavailable

3. **Alibaba Cloud Function Service (Deno)** - Uses custom runtime
   - Entry point: `index.ts` with custom bootstrap script
   - Alternative deployment option for better access in mainland China
   - Uses Deno with custom runtime via `aliyun/bootstrap`

4. **Mainland China Service** - Specialized version in Go
   - Entry point: `main.go`
   - Optimized for access within mainland China
   - Contains adaptations for the Chinese network environment

## API Endpoints

### Primary Service (Deno)

- `/latest` - Provides information about the latest launcher releases
- `/releases/:filename` - Access to launcher release files with redirection to GitHub
- `/notifications` - System notifications for launcher users from GitHub issues
- `/flights` - Feature flight information for gradual rollouts
- `/translation` - Translation services for mod descriptions (Modrinth and CurseForge)
- `/group/:id` - Real-time WebSocket communication for launcher user groups
- `/rtc/official` - WebRTC signaling for peer connections
- `/zulu` - Custom endpoint for specific launcher functionality
- `/elyby/authlib` - Authentication library access
- `/modrinth/auth` - Modrinth authentication integration
- `/kook-badge` - Access to KOOK integration information

### Backup Service (Azure Functions - Go)

- `/latest` - Similar to Deno service, provides launcher release information
- `/notifications` - Provides notifications from GitHub issues
- `/flights` - Feature flight configuration
- `/zulu` - Proxies to xmcl-static-resource repository
- `/appx` - Handles Windows appx file distribution with proxy support for Chinese users

### Mainland China Service (Go)

- `/group/:id` - Real-time WebSocket communication for groups
- `/translation` - Translation services for mod descriptions
- `/rtc/official` - WebRTC signaling service

## Environment Variables

### Primary Service (Deno)

- `MONGO_CONNECION_STRING` - Alternative name for MongoDB connection string
- `MONGODB_NAME` - Database name (default: "xmcl-api")
- `GITHUB_PAT` - GitHub Personal Access Token for API access
- `OPENAI_API_KEY` - API key for translation services using DeepSeek API
- `RTC_SECRET` - Secret for WebRTC services
- `CURSEFORGE_KEY` - API key for CurseForge integration
- `MODRINTH_SECRET` - Secret for Modrinth authentication integration
- `TURNS` - TURN server configuration (format: "realm:ip,realm:ip")

### Backup Service (Azure Functions - TypeScript)

- `GITHUB_PAT` - GitHub Personal Access Token for API access
- `FUNCTIONS_CUSTOMHANDLER_PORT` - Port for Azure Functions custom handler (legacy)
- `PORT` - Fallback port if Azure Functions port is not set (legacy)

### Mainland China Service (Go)

- `MONGO_CONNECION_STRING` - MongoDB connection string
- `MONGODB_NAME` - Database name (default: "xmcl-api")
- `CURSEFORGE_KEY` - API key for CurseForge integration
- `RTC_SECRET` - Secret for WebRTC services
- `TURNS` - TURN server configuration (format: "realm:ip,realm:ip") 
- `PORT` - Server port (default: "8080")

## Development

### Prerequisites

- [Deno](https://deno.land/) for the primary service
- [Go](https://golang.org/) for the Azure Functions and China service
- [MongoDB](https://www.mongodb.com/) for data storage
- Azure Functions Core Tools (for local Azure Functions testing)

### Local Development

```bash
# Run the Deno service locally
deno run --allow-net --allow-read --allow-env index.ts

# Build and run the Go service for China
go build main.go
./main

# Run the Azure Functions service locally
deno run build:fn
func start
```

## Deployment

### Deno Deploy

The primary service is deployed on Deno Deploy, which automatically deploys from the main branch.

### Azure Functions

For Azure Functions deployment, use the Azure CLI or Azure Portal:

```bash
az functionapp deployment source config-zip -g myResourceGroup -n myFunctionApp --src ./azure.zip
```

### Alibaba Cloud Function

The Deno service can be deployed to Alibaba Cloud Function using Serverless Devs:

```bash
# Install Serverless Devs CLI
npm install -g @serverless-devs/s

# Configure your Alibaba Cloud credentials
s config add

# Deploy the function
s deploy --use-local -y
```

The deployment uses a custom runtime with Deno and automatically deploys from the main branch via GitHub Actions.

**Required Secrets for GitHub Actions:**
- `ALIYUN_ACCOUNT_ID` - Alibaba Cloud Account ID
- `ALIYUN_ACCESS_KEY_ID` - Alibaba Cloud Access Key ID
- `ALIYUN_ACCESS_KEY_SECRET` - Alibaba Cloud Access Key Secret
- Environment variables (same as Primary Service)

### Custom Server (China)

For the China service, deploy to a suitable hosting provider with Go support:

```bash
go build -o server main.go
# Then deploy the binary to your server
```

## TURN Server

For WebRTC functionality, a COTURN server is used. Configuration details are in `COTURN.md`.

## License

This project is licensed under the MIT License - see the LICENSE file for details.