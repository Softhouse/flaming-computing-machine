FROM library/node

RUN apt-get -qqy update \
 && apt-get -qqy install apparmor \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pm2

ADD package.json /app/package.json

RUN cd /app && npm install --production

ADD . /app

WORKDIR /app

RUN chmod +x ./entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]

CMD ["pm2", "start", "/app/src/index.js", "--no-daemon"]
