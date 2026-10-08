"""Add only the TextLens vhost/mappings; validate and gracefully reload OLS."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess

DOMAIN = '72-61-224-90.sslip.io'
VHOST = 'textlens_ocr'


def listener_blocks(config):
    for match in re.finditer(r'(?im)^listener\s+([^\n{]+)\s*\{', config):
        cursor = match.end()
        depth = 1
        while cursor < len(config) and depth:
            depth += (config[cursor] == '{') - (config[cursor] == '}')
            cursor += 1
        if depth:
            raise ValueError('Unbalanced listener block')
        yield match.group(1).strip(), match.end(), cursor - 1


def add_mappings(config, tls=False):
    found_http = False
    for name, start, end in reversed(list(listener_blocks(config))):
        body = config[start:end]
        is_http = bool(re.search(r'(?m)^\s*address\s+\S+:80\s*$', body))
        is_https = bool(re.search(r'(?m)^\s*address\s+\S+:443\s*$', body))
        found_http |= is_http
        if (is_http or (tls and is_https)) and not re.search(r'(?m)^\s*map\s+' + VHOST + r'\s', body):
            config = config[:start] + f'\n  map {VHOST} {DOMAIN}\n' + config[start:]
    if not found_http:
        raise ValueError('No existing port 80 listener; refusing to change this server')
    if not re.search(r'(?im)^virtualhost\s+' + VHOST + r'\s*\{', config):
        config += f'''\nvirtualhost {VHOST} {{
  vhRoot /var/www/textlens/
  configFile /usr/local/lsws/conf/vhosts/{VHOST}/vhconf.conf
  allowSymbolLink 1
  enableScript 0
  restrained 1
}}\n'''
    return config


def vhost_config(tls):
    config = f'''docRoot /var/www/textlens/html/
vhDomain {DOMAIN}
enableGzip 1
maxReqBodySize 22M
context /.well-known/acme-challenge/ {{
  type NULL
  location /var/www/textlens/html/.well-known/acme-challenge/
  allowBrowse 1
  addDefaultCharset off
}}
extprocessor textlens_api {{
  type proxy
  address 127.0.0.1:8010
  maxConns 20
  initTimeout 150
  retryTimeout 0
  respBuffer 0
}}
context /api/ {{
  type proxy
  handler textlens_api
  addDefaultCharset off
}}
'''
    if tls:
        config += f'''vhssl {{
  keyFile /etc/letsencrypt/live/{DOMAIN}/privkey.pem
  certFile /etc/letsencrypt/live/{DOMAIN}/fullchain.pem
  certChain 1
  sslProtocol 24
}}
rewrite {{
  enable 1
  rules <<<END_rules
RewriteCond %{{HTTPS}} !=on
RewriteCond %{{REQUEST_URI}} !^/\\.well-known/acme-challenge/
RewriteRule ^ https://{DOMAIN}%{{REQUEST_URI}} [R=301,L]
END_rules
}}
'''
    return config


def configuration_errors(result):
    # Ignore changing timestamps/PIDs when comparing pre-existing diagnostics.
    return {re.sub(r'\[(?:\d+)\]\s*', '', match.group(0)) for match in re.finditer(r'\[(?:ERROR|FATAL)\][^\n]+', result.stdout + result.stderr)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tls', action='store_true', help='Enable the already-issued certificate')
    args = parser.parse_args()
    if args.tls and not Path(f'/etc/letsencrypt/live/{DOMAIN}/fullchain.pem').is_file():
        raise SystemExit('Issue the certificate with certbot webroot before enabling TLS.')
    args.tls = args.tls or Path(f'/etc/letsencrypt/live/{DOMAIN}/fullchain.pem').is_file()
    master = Path('/usr/local/lsws/conf/httpd_config.conf')
    original = master.read_text()
    baseline = subprocess.run(['/usr/local/lsws/bin/openlitespeed', '-t'], capture_output=True, text=True)
    updated = add_mappings(original, args.tls)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = master.with_name(master.name + '.textlens-' + stamp + '.bak')
    shutil.copy2(master, backup)
    folder = Path('/usr/local/lsws/conf/vhosts') / VHOST
    folder.mkdir(exist_ok=True)
    target = folder / 'vhconf.conf'
    old_vhost = target.read_bytes() if target.exists() else None
    Path('/var/www/textlens/html/.well-known/acme-challenge').mkdir(parents=True, exist_ok=True)
    target.write_text(vhost_config(args.tls))
    master.write_text(updated)
    result = subprocess.run(['/usr/local/lsws/bin/openlitespeed', '-t'], capture_output=True, text=True)
    errors = configuration_errors(result) - configuration_errors(baseline)
    if errors or (result.returncode and not baseline.returncode):
        master.write_text(original)
        if old_vhost is not None:
            target.write_bytes(old_vhost)
        else:
            target.unlink()
        raise SystemExit('TextLens configuration validation failed; original configuration restored. ' + '\n'.join(sorted(errors)))
    subprocess.run(['/usr/local/lsws/bin/lswsctrl', 'reload'], check=True)
    print('TextLens vhost configured; existing listener maps preserved. Backup:', backup)


if __name__ == '__main__':
    main()
