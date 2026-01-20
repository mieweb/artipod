#!/usr/bin/env node

import { loadConfig } from './config.js';
import { ArtiPodMCPServer } from './server.js';

/**
 * Entry point for ArtiPod MCP Server
 */
async function main() {
  try {
    // Load configuration from environment
    const config = loadConfig();

    // Create and start server
    const server = new ArtiPodMCPServer(config);
    await server.start();
  } catch (error) {
    console.error('Failed to start ArtiPod MCP Server:', error);
    process.exit(1);
  }
}

main();
