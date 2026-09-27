FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

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
