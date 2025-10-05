#!/bin/bash
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./configure-claude.sh <proxy-url>"
  echo ""
  echo "Examples:"
  echo "  ./configure-claude.sh http://localhost:8082"
  echo "  ./configure-claude.sh https://claude-proxy.company.com"
  exit 0
fi

PROXY_URL="$1"
CONFIG_DIR="$HOME/.claude"
CONFIG_FILE="$CONFIG_DIR/settings.json"

echo "🔧 Configuring Claude Code"
echo "   Proxy: $PROXY_URL"
echo "   Config: $CONFIG_FILE"
echo ""

# Ensure config directory exists
mkdir -p "$CONFIG_DIR"

# Update settings.json using Node.js
node --eval '
  const fs = require("fs");
  const path = require("path");
  
  const configFile = "'"$CONFIG_FILE"'";
  const proxyUrl = "'"$PROXY_URL"'";
  
  // Read existing config or start fresh
  let config = {};
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    } catch (err) {
      console.error("⚠️  Warning: Could not parse existing config, creating new one");
    }
  }
  
  // Update env settings
  config.env = config.env || {};
  config.env.ANTHROPIC_BASE_URL = proxyUrl;
  
  // Write back
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf-8");
' || {
  echo "❌ Failed to update config"
  exit 1
}

echo "✅ Configuration updated"
echo ""
echo "Test with: claude"
