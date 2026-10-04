FROM alpine:3.19

# Install minimal required packages
RUN apk add --no-cache bash coreutils

# Create unprivileged user
RUN addgroup -g 1000 artipod && \
    adduser -D -u 1000 -G artipod artipod

# Create context directory for future ArtiPod mounts
RUN mkdir -p /context && \
    chown artipod:artipod /context

# Switch to unprivileged user
USER artipod

# Set working directory
WORKDIR /context

# Default command
CMD ["/bin/bash", "-c", "while true; do sleep 1; done"]
