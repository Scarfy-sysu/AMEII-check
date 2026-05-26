#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/certs"
IP="${1:-127.0.0.1}"

mkdir -p "$CERT_DIR"

cat > "$CERT_DIR/openssl.cnf" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
C = CN
ST = GD
L = GZ
O = facecheck
CN = ${IP}

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = ${IP}
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

openssl req -x509 -nodes -days 3650 \
  -newkey rsa:2048 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -config "$CERT_DIR/openssl.cnf"

echo "cert generated: $CERT_DIR/cert.pem"
echo "key generated : $CERT_DIR/key.pem"
