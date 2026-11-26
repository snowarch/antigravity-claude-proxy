/**
 * Minimal RFC 6455 WebSocket server codec (zero external dependencies).
 * Works over any Node.js Duplex socket (net.Socket or tls.TLSSocket).
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

const WS_GUID = '258EAFA5-E914-47CF-A5D0-C5496505677A';
const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB safety cap per frame

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;

/**
 * Encode a server-to-client WebSocket frame (unmasked per RFC 6455).
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
    const len = payload.length;
    let header;

    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | (opcode & 0x0f);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | (opcode & 0x0f);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | (opcode & 0x0f);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
    constructor(socket, head) {
        super();
        this.socket = socket;
        this.closed = false;
        this._buffer = Buffer.alloc(0);
        this._fragOpcode = null;
        this._fragChunks = [];
        this._fragLength = 0;

        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('end', () => {
            if (!this.closed) {
                this.close(1000, '');
            }
        });
        socket.on('error', (err) => {
            if (!this.closed) {
                this.emit('error', err);
            }
        });
        socket.on('close', () => {
            if (!this.closed) {
                this.closed = true;
                this.emit('close', 1006, '');
            }
        });

        if (head && head.length > 0) {
            this._onData(head);
        }
    }

    sendText(text) {
        if (this.closed || this.socket.destroyed) return false;
        try {
            this.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')));
            return true;
        } catch {
            return false;
        }
    }

    sendJson(obj) {
        return this.sendText(JSON.stringify(obj));
    }

    sendPong(payload = Buffer.alloc(0)) {
        if (this.closed || this.socket.destroyed) return;
        try {
            this.socket.write(encodeFrame(OPCODE_PONG, payload));
        } catch {
            // ignore write errors during teardown
        }
    }

    close(code = 1000, reason = '') {
        if (this.closed) return;
        this.closed = true;
        try {
            const reasonBuf = Buffer.from(reason, 'utf8');
            const payload = Buffer.alloc(2 + reasonBuf.length);
            payload.writeUInt16BE(code, 0);
            reasonBuf.copy(payload, 2);
            if (!this.socket.destroyed) {
                this.socket.end(encodeFrame(OPCODE_CLOSE, payload));
            }
        } catch {
            if (!this.socket.destroyed) this.socket.destroy();
        }
        this.emit('close', code, reason);
    }

    _onData(chunk) {
        if (this.closed) return;
        this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

        while (this._buffer.length >= 2) {
            const b0 = this._buffer[0];
            const b1 = this._buffer[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let payloadLen = b1 & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
                if (this._buffer.length < 4) return;
                payloadLen = this._buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (this._buffer.length < 10) return;
                const bigLen = this._buffer.readBigUInt64BE(2);
                if (bigLen > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
                    this.close(1009, 'Frame too large');
                    return;
                }
                payloadLen = Number(bigLen);
                offset = 10;
            }

            if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
                this.close(1009, 'Frame too large');
                return;
            }

            const maskLen = masked ? 4 : 0;
            const frameLen = offset + maskLen + payloadLen;
            if (this._buffer.length < frameLen) return;

            let payload = Buffer.from(this._buffer.subarray(offset + maskLen, frameLen));
            if (masked) {
                const mask = this._buffer.subarray(offset, offset + 4);
                for (let i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i & 3];
                }
            }

            this._buffer = this._buffer.subarray(frameLen);
            this._handleFrame(fin, opcode, payload);
            if (this.closed) return;
        }
    }

    _handleFrame(fin, opcode, payload) {
        if (opcode === OPCODE_PING) {
            this.sendPong(payload);
            return;
        }
        if (opcode === OPCODE_PONG) {
            return;
        }
        if (opcode === OPCODE_CLOSE) {
            let code = 1000;
            let reason = '';
            if (payload.length >= 2) {
                code = payload.readUInt16BE(0);
                reason = payload.subarray(2).toString('utf8');
            }
            this.close(code, reason);
            return;
        }

        if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
            if (fin) {
                this._emitMessage(opcode, payload);
            } else {
                this._fragOpcode = opcode;
                this._fragChunks = [payload];
                this._fragLength = payload.length;
            }
            return;
        }

        if (opcode === OPCODE_CONTINUATION && this._fragOpcode !== null) {
            this._fragLength += payload.length;
            if (this._fragLength > MAX_FRAME_PAYLOAD_BYTES) {
                this.close(1009, 'Message too large');
                return;
            }
            this._fragChunks.push(payload);
            if (fin) {
                const full = Buffer.concat(this._fragChunks, this._fragLength);
                const msgOpcode = this._fragOpcode;
                this._fragOpcode = null;
                this._fragChunks = [];
                this._fragLength = 0;
                this._emitMessage(msgOpcode, full);
            }
        }
    }

    _emitMessage(opcode, payload) {
        if (opcode === OPCODE_TEXT) {
            this.emit('message', payload.toString('utf8'), false);
        } else if (opcode === OPCODE_BINARY) {
            this.emit('message', payload, true);
        }
    }
}

/**
 * Perform the HTTP 101 WebSocket server handshake and return a WebSocketConnection.
 * Returns null if the upgrade request is invalid.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('stream').Duplex} socket
 * @param {Buffer} head
 * @returns {WebSocketConnection|null}
 */
export function acceptWebSocket(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers['upgrade'] || '').toLowerCase();

    if (!key || upgrade !== 'websocket') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return null;
    }

    const accept = crypto
        .createHash('sha1')
        .update(key.trim() + WS_GUID)
        .digest('base64');

    const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
    ].join('\r\n');

    socket.write(responseHeaders);
    return new WebSocketConnection(socket, head);
}
