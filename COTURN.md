# Coturn Setup

```bash
wget https://github.com/coturn/coturn/archive/refs/tags/4.6.2.tar.gz
tar -xvf ./4.6.2.tar.gz
cd coturn-4.6.2/
./configure
```

Now install missing dependencies:

```bash
sudo apt-get install libssl-dev libevent-dev libmongoc-dev gcc make pkg-config
```

Configure and make and install:

```bash
./configure
make
sudo make install
```

## Concifg turnserver

Config `/etc/turnserver.conf`.

### Behind NAT

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

### Azure Cloud

```conf
external-ip=<public-ip>

verbose

fingerprint

use-auth-secret

static-auth-secret=<secret>

mongo-userdb=<connection-string>

realm=xmcl

syslog
```

## Service

Create service (/etc/systemd/system/turnserver.service):

```service
[Unit]
Description=turnserver

[Service]
ExecStart=/root/coturn-4.6.2/bin/turnserver
Restart=always
User=root
Group=nogroup
Environment=PATH=/usr/bin:/usr/local/bin
WorkingDirectory=/root

[Install]
WantedBy=multi-user.target
```

or 


```service
[Unit]
Description=turnserver

[Service]
ExecStart=/home/ci010/coturn-4.6.2/bin/turnserver
Restart=always
User=ci010
Group=nogroup
Environment=PATH=/usr/bin:/usr/local/bin
WorkingDirectory=/home/ci010

[Install]
WantedBy=multi-user.target
```

### Enable

```bash
sudo systemctl enable turnserver.service
sudo systemctl start turnserver.service
sudo systemctl status turnserver.service
```