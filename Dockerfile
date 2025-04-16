FROM node:23-alpine

# Install build dependencies
RUN apk add --no-cache typescript

# Add non-root user
RUN addgroup -S group && adduser -S user -G group

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

# Run everything as `user`
RUN chown -R user:group /app
USER user

# Create temp directory for file processing
RUN mkdir -p temp

# Set environment variables (these can be overridden via docker-compose)
ENV NODE_ENV=production

# Run the application
CMD ["node", "dist/index.js"]
