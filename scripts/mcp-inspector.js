#!/usr/bin/env node

import { MCP } from '@modelcontextprotocol/sdk';
import dotenv from 'dotenv';

dotenv.config();

// Configuration from environment variables
const MCP_PORT = process.env.MCP_PORT || 3000;
const MCP_HOST = process.env.MCP_HOST || 'localhost';

async function inspectMCP() {
  console.log('MCP Inspector Starting...');
  console.log(`Connecting to MCP server at ${MCP_HOST}:${MCP_PORT}`);
  
  try {
    const mcp = new MCP({
      port: MCP_PORT,
      host: MCP_HOST,
    });
    
    // Get available services
    const services = await mcp.getServices();
    console.log('\nAvailable Services:');
    console.table(services);
    
    // Test connection status
    const status = await mcp.getStatus();
    console.log('\nMCP Connection Status:');
    console.table(status);
    
    // Get capabilities if supported
    try {
      const capabilities = await mcp.getCapabilities();
      console.log('\nMCP Capabilities:');
      console.table(capabilities);
    } catch (e) {
      console.log('\nCapabilities endpoint not supported or error occurred');
    }
    
    console.log('\nMCP Inspection Complete');
  } catch (error) {
    console.error('\nError connecting to MCP server:');
    console.error(error.message);
    process.exit(1);
  }
}

inspectMCP(); 