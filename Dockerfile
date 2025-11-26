FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy scripts
COPY scripts/ ./scripts/

# Create data directory
RUN mkdir -p /data

# Set environment variables
ENV NEAR_RPC_ENDPOINT=https://archival-rpc.mainnet.fastnear.com
ENV RPC_DELAY_MS=50

# Set entrypoint
ENTRYPOINT ["node", "scripts/get-account-history.js"]

# Default command shows help
CMD ["--help"]
