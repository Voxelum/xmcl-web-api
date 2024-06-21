# Coturn Setup

```bash
wget https://github.com/coturn/coturn/archive/refs/tags/4.6.2.tar.gz
tar -xvf ./4.6.2.tar.gz
cd coturn-4.6.2/
./configure
```

Now install missing dependencies:

```bash
sudo apt-get install libssl-dev libevent-dev libmongoc-dev gcc make package-config
```

Configure and make and install:

```bash
./configure
make
sudo make install
```

Create conf file:

```conf
listening-ip=0.0.0.0
listening-ip=<private-ip>

external-ip=<public-ip>/<private-ip>

min-port=<port-start>
max-port=<port-end>

verbose

fingerprint

use-auth-secret

static-auth-secret=<secret>

mongo-userdb=<connection-string>

realm=xmcl

syslog
```

You need to replace `<private-ip>`, `<public-ip>`, `<port-start>`, `<port-end>`, `<secret>`, and `<connection-string>` with your own values.

Make sure the udp ports are open in your firewall.