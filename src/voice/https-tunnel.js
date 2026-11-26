/**
 * Local HTTPS CONNECT tunnel + direct WebSocket upgrade wiring for Claude Code /voice.
 *
 * Why this exists:
 * Claude Code hardcodes `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`
 * for `/voice` (ignoring `ANTHROPIC_BASE_URL`), while honoring `HTTPS_PROXY` and
 * `NODE_EXTRA_CA_CERTS`.
 *
 * When Claude Code connects via `HTTPS_PROXY=http://localhost:8080`:
 * - `CONNECT api.anthropic.com:443` is terminated locally with an auto-generated
 *   CA + leaf certificate (stored in `~/.config/antigravity-proxy/certs/`) so
 *   `/api/ws/speech_to_text/voice_stream` is transcribed by Cloud Code Gemini.
 * - Any other `CONNECT host:port` from localhost is passed through as a raw TCP
 *   tunnel with zero TLS inspection.
 * - Non-loopback `CONNECT` requests are rejected (403) so the proxy never acts as
 *   an open relay on LAN interfaces.
 */

import http from 'http';
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { logger } from '../utils/logger.js';
import { VOICE_STREAM_PATH, handleVoiceStreamUpgrade } from './voice-stream.js';

const INTERCEPT_HOST = 'api.anthropic.com';
const DEFAULT_CERT_DIR = path.join(os.homedir(), '.config/antigravity-proxy/certs');

/**
 * Return the directory used to store the local CA and leaf certificate.
 * @returns {string}
 */
export function getCertDir() {
    return process.env.ANTIGRAVITY_CERT_DIR || DEFAULT_CERT_DIR;
}

/**
 * Return the path to the local CA certificate PEM file (for NODE_EXTRA_CA_CERTS).
 * @param {string} [certDir]
 * @returns {string}
 */
export function getCaCertPath(certDir = getCertDir()) {
    return path.join(certDir, 'ca.pem');
}

/**
 * Generate (once) and load the local CA and `api.anthropic.com` leaf cert.
 *
 * @param {string} [certDir]
 * @returns {{ caPath: string, key: Buffer, cert: Buffer }}
 */
export function ensureVoiceCertificates(certDir = getCertDir()) {
    const caKeyPath = path.join(certDir, 'ca-key.pem');
    const caCertPath = path.join(certDir, 'ca.pem');
    const leafKeyPath = path.join(certDir, `${INTERCEPT_HOST}-key.pem`);
    const leafCertPath = path.join(certDir, `${INTERCEPT_HOST}.pem`);
    const csrPath = path.join(certDir, `${INTERCEPT_HOST}.csr`);
    const extPath = path.join(certDir, `${INTERCEPT_HOST}.ext`);

    if (!fs.existsSync(caCertPath) || !fs.existsSync(leafCertPath) || !fs.existsSync(leafKeyPath)) {
        fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });

        if (!fs.existsSync(caKeyPath) || !fs.existsSync(caCertPath)) {
            execFileSync('openssl', [
                'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', caKeyPath,
                '-out', caCertPath,
                '-days', '3650',
                '-subj', '/CN=Antigravity Proxy Local CA',
                '-addext', 'basicConstraints=critical,CA:TRUE',
                '-addext', 'keyUsage=critical,keyCertSign,cRLSign'
            ], { stdio: 'ignore' });
            fs.chmodSync(caKeyPath, 0o600);
        }

        const extContent = [
            'basicConstraints=CA:FALSE',
            'keyUsage=digitalSignature,keyEncipherment',
            'extendedKeyUsage=serverAuth',
            `subjectAltName=DNS:${INTERCEPT_HOST}`
        ].join('\n') + '\n';
        fs.writeFileSync(extPath, extContent, { mode: 0o600 });

        execFileSync('openssl', [
            'req', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', leafKeyPath,
            '-out', csrPath,
            '-subj', `/CN=${INTERCEPT_HOST}`
        ], { stdio: 'ignore' });
        fs.chmodSync(leafKeyPath, 0o600);

        execFileSync('openssl', [
            'x509', '-req',
            '-in', csrPath,
            '-CA', caCertPath,
            '-CAkey', caKeyPath,
            '-CAcreateserial',
            '-out', leafCertPath,
            '-days', '3650',
            '-extfile', extPath
        ], { stdio: 'ignore' });

        // Clean up temporary CSR/ext files
        for (const tmp of [csrPath, extPath]) {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }

        logger.info(`[Voice] Generated local CA certificate at ${caCertPath}`);
    }

    return {
        caPath: caCertPath,
        key: fs.readFileSync(leafKeyPath),
        cert: fs.readFileSync(leafCertPath)
    };
}

function isLoopbackAddress(addr) {
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function parseConnectAuthority(rawUrl) {
    const raw = String(rawUrl || '').trim();
    if (!raw) return null;

    // Handle IPv6 [::1]:443 or hostname:443
    let host;
    let portStr;
    if (raw.startsWith('[')) {
        const closeIdx = raw.indexOf(']');
        if (closeIdx === -1 || raw[closeIdx + 1] !== ':') return null;
        host = raw.slice(1, closeIdx);
        portStr = raw.slice(closeIdx + 2);
    } else {
        const colonIdx = raw.lastIndexOf(':');
        if (colonIdx === -1) return null;
        host = raw.slice(0, colonIdx);
        portStr = raw.slice(colonIdx + 1);
    }

    const port = Number(portStr);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }
    return { host: host.toLowerCase(), port };
}

/**
 * Create the internal HTTP server that handles TLS-terminated requests destined
 * for `api.anthropic.com` (voice WebSocket, /api/hello, /v1/*, and quiet /api/* stubs).
 */
function createInterceptServer({ app, voiceDeps }) {
    const interceptServer = http.createServer((req, res) => {
        const pathname = new URL(req.url || '/', 'https://api.anthropic.com').pathname;

        if (pathname === '/api/hello') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
            return;
        }

        if (pathname === '/api/event_logging/batch') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }

        // Delegate Anthropic API routes (/v1/*) directly to Express app if anything hits them here
        if (pathname.startsWith('/v1/') && typeof app === 'function') {
            app(req, res);
            return;
        }

        // Stub other /api/* endpoints (OAuth profile, policy_limits, etc.) with 200 {}
        // so Claude Code does not leak a dummy token to Anthropic or trigger 401 logout.
        if (pathname.startsWith('/api/')) {
            logger.debug(`[VoiceTunnel] Stubbed ${req.method} ${pathname} -> 200 {}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(req.method === 'HEAD' ? undefined : '{}');
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
    });

    interceptServer.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url || '/', 'https://api.anthropic.com').pathname;
        if (pathname === VOICE_STREAM_PATH) {
            handleVoiceStreamUpgrade(req, socket, head, voiceDeps);
            return;
        }
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
    });

    return interceptServer;
}

/**
 * Attach both direct WebSocket upgrade support (`ws://localhost:PORT/...`) and
 * localhost-only HTTP CONNECT tunneling (`HTTPS_PROXY=http://localhost:PORT`) to
 * the proxy's HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {Object} options
 * @returns {{ caPath: string|null }}
 */
export function attachVoiceAndTunnel(httpServer, {
    app,
    accountManager,
    ensureInitialized,
    sendMessageFn,
    getAvailableModelIdsFn,
    certDir
}) {
    const voiceDeps = {
        accountManager,
        ensureInitialized,
        ...(sendMessageFn ? { sendMessageFn } : {}),
        ...(getAvailableModelIdsFn ? { getAvailableModelIdsFn } : {})
    };

    let certBundle = null;
    try {
        certBundle = ensureVoiceCertificates(certDir);
    } catch (err) {
        logger.warn(`[Voice] Could not initialize local CA certificates (openssl missing?): ${err.message}`);
    }

    const interceptServer = createInterceptServer({ app, voiceDeps });

    // Direct WebSocket upgrade on http://localhost:PORT/api/ws/speech_to_text/voice_stream
    httpServer.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (pathname === VOICE_STREAM_PATH) {
            handleVoiceStreamUpgrade(req, socket, head, voiceDeps);
            return;
        }
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
    });

    // HTTP CONNECT proxy handler (strictly loopback-only)
    httpServer.on('connect', (req, clientSocket, head) => {
        if (!isLoopbackAddress(clientSocket.remoteAddress)) {
            clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            clientSocket.destroy();
            return;
        }

        const target = parseConnectAuthority(req.url);
        if (!target) {
            clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            clientSocket.destroy();
            return;
        }

        // Intercept ONLY api.anthropic.com:443 for local voice STT + stubbed Anthropic control endpoints
        if (target.host === INTERCEPT_HOST && target.port === 443 && certBundle) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) {
                clientSocket.unshift(head);
            }

            const tlsSocket = new tls.TLSSocket(clientSocket, {
                isServer: true,
                key: certBundle.key,
                cert: certBundle.cert
            });

            tlsSocket.on('error', (err) => {
                logger.debug(`[VoiceTunnel] TLS error: ${err.message}`);
            });
            tlsSocket.on('close', () => {
                if (!clientSocket.destroyed) clientSocket.destroy();
            });
            clientSocket.on('close', () => {
                if (!tlsSocket.destroyed) tlsSocket.destroy();
            });

            interceptServer.emit('connection', tlsSocket);
            return;
        }

        // Raw TCP passthrough tunnel for all other hosts (zero TLS interception)
        const upstream = net.connect(target.port, target.host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });

        upstream.on('error', () => {
            if (!clientSocket.destroyed) {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
                clientSocket.destroy();
            }
        });
        upstream.on('close', () => {
            if (!clientSocket.destroyed) clientSocket.destroy();
        });

        clientSocket.on('error', () => {
            if (!upstream.destroyed) upstream.destroy();
        });
        clientSocket.on('close', () => {
            if (!upstream.destroyed) upstream.destroy();
        });
    });

    return { caPath: certBundle?.caPath || null };
}
