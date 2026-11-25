# Throwaway image for the Linux host selftest (CI and local).
# Build:  docker build -t quiet-office-linux-test -f hosts/linux/test/Dockerfile hosts/linux/test
# Run:    docker run --rm -v "$PWD:/repo:ro" quiet-office-linux-test sh /repo/hosts/linux/test/run-selftest.sh
#         (needs web/dist built; or mount a build: -v <dist>:/dist:ro -e WEB_DIR=/dist)
FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1 \
      gir1.2-gtklayershell-0.1 gir1.2-ayatanaappindicator3-0.1 gir1.2-wnck-3.0 \
      xvfb xauth dbus-x11 libgl1-mesa-dri fonts-dejavu-core ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# Official Node binary from the node image: no install script runs.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version && useradd -m tester
USER tester
WORKDIR /home/tester
