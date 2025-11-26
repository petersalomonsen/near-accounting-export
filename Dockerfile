FROM node:20-alpine

WORKDIR /app

# Copy package files and tsconfig
COPY package*.json tsconfig.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy TypeScript source
COPY scripts/ ./scripts/

# Build TypeScript
RUN npm run build

# Remove devDependencies to reduce image size
RUN npm prune --production

# Create data directory
RUN mkdir -p /data

# Set environment variables
ENV NEAR_RPC_ENDPOINT=https://archival-rpc.mainnet.fastnear.com
ENV RPC_DELAY_MS=50

# Set entrypoint
ENTRYPOINT ["node", "dist/scripts/get-account-history.js"]

# Default command shows help
CMD ["--help"]
