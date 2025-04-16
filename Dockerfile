FROM node:23-alpine

# Install build dependencies
RUN apk add --no-cache typescript

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit-dev

# Copy source code
COPY . .

# Build the TypeScript code
RUN --mount=type=cache,target=/root/.npm npm run build

# Create temp directory for file processing
RUN mkdir -p temp

# Expose any ports if needed (add if necessary)
# EXPOSE 3000

# Set environment variables (these can be overridden via docker-compose)
ENV NODE_ENV=production

# Run the application
CMD ["node", "dist/index.js"]
