#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this one-time setup as root: sudo bash deploy/bootstrap-almalinux.sh' >&2
  exit 1
fi
# /etc/os-release is the operating system's own configuration.
# shellcheck disable=SC1091
source /etc/os-release
if [[ ${ID:-} != almalinux ]]; then
  echo 'This installer is for AlmaLinux. The containers do not require reinstalling your OS.' >&2
  exit 1
fi
if ! command -v docker >/dev/null; then
  dnf install -y dnf-plugins-core curl openssl git
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  dnf install -y curl openssl git
fi
systemctl enable --now docker
docker compose version

# Reuse OpenLiteSpeed on this VPS instead of binding over existing sites.
if [[ -n $(ss -H -ltn '( sport = :80 or sport = :443 )') ]] && \
   [[ ! -f /usr/local/lsws/conf/httpd_config.conf ]]; then
  echo 'Ports 80/443 are in use by a different proxy; configure it to forward to 127.0.0.1:8010 first.' >&2
  exit 1
fi
if ! id textlens-deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash textlens-deploy
fi
usermod -aG docker textlens-deploy
install -d -m 0750 -o textlens-deploy -g textlens-deploy /opt/textlens /opt/textlens/releases
install -d -m 0700 -o textlens-deploy -g textlens-deploy /home/textlens-deploy/.ssh
touch /home/textlens-deploy/.ssh/authorized_keys
chown textlens-deploy:textlens-deploy /home/textlens-deploy/.ssh/authorized_keys
chmod 0600 /home/textlens-deploy/.ssh/authorized_keys
if [[ ! -f /opt/textlens/.env ]]; then
  install -m 0600 -o textlens-deploy -g textlens-deploy "$(dirname "${BASH_SOURCE[0]}")/.env.example" /opt/textlens/.env
fi
# SSH directories may need their default SELinux labels after creation.
if command -v restorecon >/dev/null; then
  restorecon -R /home/textlens-deploy/.ssh
fi
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi
echo 'Docker and the deploy user are ready. Configure /opt/textlens/.env and add the GitHub deploy public key.'
echo 'Also allow TCP 80/443 in the Hostinger firewall. SSH keeps its existing port.'
echo 'Configure the existing OpenLiteSpeed virtual host with deploy/configure-openlitespeed.py.'
