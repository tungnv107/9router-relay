FROM oven/bun:1.4.2
WORKDIR /app
COPY --chown=bun:bun . ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV CH_HOME=/data CH_PORT=0 CH_SHARE_PORT=11500 CH_ADMIN_PORT=11504
EXPOSE 11500 11504
CMD ["bun", "entry.mjs", "start", "--admin-port", "11504"]
