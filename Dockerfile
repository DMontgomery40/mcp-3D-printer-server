FROM node:18-alpine

# Install build dependencies
RUN apk add --no-cache typescript

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the TypeScript code
RUN npm run build

# Create temp directory for file processing
RUN mkdir -p temp

# Expose any ports if needed (add if necessary)
# EXPOSE 3000

# Set environment variables (these can be overridden via docker-compose)
ENV NODE_ENV=production

# Run the application
CMD ["node", "dist/index.js"]
