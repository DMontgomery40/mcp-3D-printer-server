FROM node:23-alpine@sha256:86703151a18fcd06258e013073508c4afea8e19cd7ed451554221dd00aea83fc

# Install build-time TypeScript compiler
RUN apk add --no-cache typescript

# Add non-root user
RUN addgroup -S group && adduser -S user -G group

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies needed for build
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the TypeScript code
RUN npm run build && npm prune --omit=dev

# Run everything as `user`
RUN chown -R user:group /app
USER user

# Create temp directory for file processing
RUN mkdir -p temp

# Set environment variables (these can be overridden via docker-compose)
ENV NODE_ENV=production

# Run the application
CMD ["node", "dist/index.js"]
