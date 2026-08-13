#!/bin/bash
 
echo "📦 Installing dependencies..."
export PATH="$HOME/.nvm/versions/node/v18.20.4/bin:$PATH"
npm install --legacy-peer-deps
 
echo "♻️ Restarting PM2..."
pm2 restart madanlal_grocery_backend || pm2 start index.js --name madanlal_grocery_backend
 
echo "✅ Deployment Completed!"