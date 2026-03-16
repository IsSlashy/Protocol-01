# ============================================================================
# P01 Tor SOCKS5 Proxy — Alpine-based, minimal attack surface
# ============================================================================
#
# Provides a SOCKS5 proxy at port 9050 for the P01 Bundle Engine.
# This container ONLY acts as a Tor client — it is NOT an exit node or relay.
#
# Size: ~15MB
# ============================================================================

FROM alpine:3.21

RUN apk add --no-cache tor

COPY torrc /etc/tor/torrc

RUN mkdir -p /var/lib/tor && \
    chown -R tor:tor /var/lib/tor && \
    chmod 700 /var/lib/tor

USER tor

EXPOSE 9050

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD nc -z localhost 9050 || exit 1

CMD ["tor", "-f", "/etc/tor/torrc"]
