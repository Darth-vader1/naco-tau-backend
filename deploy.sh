#!/bin/bash

# Deploy to Render
echo "🚀 Deploying NACOS Backend..."

# Install dependencies
npm install --production

# Run migrations
node scripts/migrate.js

# Seed admin user
node scripts/seed-admin.js

# Start server
npm start