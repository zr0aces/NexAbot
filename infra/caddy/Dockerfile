FROM caddy:2.11.9-alpine
RUN chown -R 1000:1000 /data /config
COPY Caddyfile /etc/caddy/Caddyfile
USER 1000:1000
