const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function buildTonePcm(seconds = 0.5, sampleRate = 16000, amplitude = 6000) {
    const samples = Math.floor(seconds * sampleRate);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude), i * 2);
    }
    return buf;
}

function encodeClientFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) {
        masked[i] ^= mask[i & 3];
    }
    return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(buf) {
    const frames = [];
    let offset = 0;
    while (offset + 2 <= buf.length) {
        const opcode = buf[offset] & 0x0f;
        let len = buf[offset + 1] & 0x7f;
        let hdrLen = 2;
        if (len === 126) {
            if (offset + 4 > buf.length) break;
            len = buf.readUInt16BE(offset + 2);
            hdrLen = 4;
        } else if (len === 127) {
            if (offset + 10 > buf.length) break;
            len = Number(buf.readBigUInt64BE(offset + 2));
            hdrLen = 10;
        }
        if (offset + hdrLen + len > buf.length) break;
        const payload = buf.subarray(offset + hdrLen, offset + hdrLen + len);
        frames.push({ opcode, payload });
        offset += hdrLen + len;
    }
    return { frames, remaining: buf.subarray(offset) };
}

function runWsOverSocket(socket, hostHeader, urlPath, pcmChunk) {
    return new Promise((resolve, reject) => {
        const wsKey = crypto.randomBytes(16).toString('base64');
        const reqStr = [
            `GET ${urlPath} HTTP/1.1`,
            `Host: ${hostHeader}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${wsKey}`,
            'Sec-WebSocket-Version: 13',
            'x-config-keyterms: antigravity,claude',
            '\r\n'
        ].join('\r\n');

        let upgraded = false;
        let rawBuf = Buffer.alloc(0);
        const received = [];

        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error(`WebSocket test timed out. Received so far: ${JSON.stringify(received)}`));
        }, 5000);

        socket.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        socket.on('data', (chunk) => {
            rawBuf = Buffer.concat([rawBuf, chunk]);
            if (!upgraded) {
                const idx = rawBuf.indexOf('\r\n\r\n');
                if (idx === -1) return;
                const hdr = rawBuf.subarray(0, idx).toString('utf8');
                assert.match(hdr, /^HTTP\/1\.1 101 Switching Protocols/i);
                upgraded = true;
                rawBuf = rawBuf.subarray(idx + 4);

                socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'KeepAlive' }))));
                if (pcmChunk && pcmChunk.length > 0) {
                    socket.write(encodeClientFrame(0x2, pcmChunk));
                }
                socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'CloseStream' }))));
            }

            if (upgraded && rawBuf.length > 0) {
                const { frames, remaining } = parseServerFrames(rawBuf);
                rawBuf = remaining;
                for (const frame of frames) {
                    if (frame.opcode === 0x1) {
                        const msg = JSON.parse(frame.payload.toString('utf8'));
                        received.push(msg);
                        if (msg.type === 'TranscriptEndpoint' || msg.type === 'TranscriptError') {
                            clearTimeout(timeout);
                            socket.destroy();
                            resolve(received);
                            return;
                        }
                    }
                }
            }
        });

        socket.write(reqStr);
    });
}

async function runTests() {
    const { pcmToWav, hasSpeechEnergy, resolveVoiceModel, cleanTranscript, VOICE_STREAM_PATH } = await import('../src/voice/voice-stream.js');
    const { attachVoiceAndTunnel } = await import('../src/voice/https-tunnel.js');

    // 1. pcmToWav builds a valid 44-byte RIFF/WAVE header
    {
        const pcm = buildTonePcm(0.25);
        const wav = pcmToWav(pcm, 16000, 1);
        assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
        assert.equal(wav.readUInt32LE(24), 16000);
        assert.equal(wav.readUInt16LE(22), 1);
        assert.equal(wav.readUInt32LE(40), pcm.length);
        assert.equal(wav.length, 44 + pcm.length);
        console.log('PASS: pcmToWav header integrity');
    }

    // 2. hasSpeechEnergy distinguishes silence from audio signal
    {
        const silence = Buffer.alloc(16000 * 2);
        const tone = buildTonePcm(0.5);
        assert.equal(hasSpeechEnergy(silence), false);
        assert.equal(hasSpeechEnergy(tone), true);
        console.log('PASS: hasSpeechEnergy rejects silence and accepts speech');
    }

    // 3. resolveVoiceModel prefers fast Flash models and honors override
    {
        assert.equal(resolveVoiceModel(['claude-opus-5-5', 'gemini-3.5-flash-lite', 'gemini-3.8-flash-low'], ''), 'gemini-3.8-flash-low');
        assert.equal(resolveVoiceModel(['gemini-3.5-flash-lite'], ''), 'gemini-3.5-flash-lite');
        assert.equal(resolveVoiceModel(['gemini-3.8-flash-low'], 'gemini-custom-stt'), 'gemini-custom-stt');
        console.log('PASS: resolveVoiceModel priority and override');
    }

    // 4. cleanTranscript strips quotes and silence markers
    {
        assert.equal(cleanTranscript('  "Hola mundo"  '), 'Hola mundo');
        assert.equal(cleanTranscript('[silence]'), '');
        assert.equal(cleanTranscript('EMPTY'), '');
        console.log('PASS: cleanTranscript normalization');
    }

    // Start test HTTP server with attached voice + CONNECT tunnel in an isolated cert dir
    const tempCertDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-voice-test-'));
    const capturedRequests = [];
    const mockSendMessage = async (req) => {
        capturedRequests.push(req);
        return {
            content: [{ type: 'text', text: 'Probando transcripcion por voz.' }]
        };
    };

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
    });

    const { caPath } = attachVoiceAndTunnel(server, {
        accountManager: {},
        ensureInitialized: async () => {},
        sendMessageFn: mockSendMessage,
        getAvailableModelIdsFn: () => ['gemini-3.8-flash-low'],
        certDir: tempCertDir
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        // 5. Direct WebSocket ws://127.0.0.1:<port>/api/ws/speech_to_text/voice_stream
        {
            const sock = net.connect(port, '127.0.0.1');
            await new Promise((resolve, reject) => {
                sock.once('connect', resolve);
                sock.once('error', reject);
            });
            const messages = await runWsOverSocket(
                sock,
                `127.0.0.1:${port}`,
                `${VOICE_STREAM_PATH}?encoding=linear16&sample_rate=16000&channels=1&language=es`,
                buildTonePcm(0.4)
            );
            assert.deepEqual(messages.map(m => m.type), ['TranscriptInterim', 'TranscriptText', 'TranscriptEndpoint']);
            assert.equal(messages[0].data, '');
            assert.equal(messages[1].data, 'Probando transcripcion por voz.');
            assert.equal(capturedRequests.length, 1);
            assert.equal(capturedRequests[0].model, 'gemini-3.8-flash-low');
            assert.equal(capturedRequests[0].messages[0].content[0].source.media_type, 'audio/wav');
            console.log('PASS: direct WebSocket voice_stream transcription');
        }

        // 6. Silence-only stream skips Gemini call and resolves with TranscriptEndpoint
        {
            const sock = net.connect(port, '127.0.0.1');
            await new Promise((resolve, reject) => {
                sock.once('connect', resolve);
                sock.once('error', reject);
            });
            const messages = await runWsOverSocket(
                sock,
                `127.0.0.1:${port}`,
                `${VOICE_STREAM_PATH}?encoding=linear16&sample_rate=16000&channels=1`,
                Buffer.alloc(16000)
            );
            assert.deepEqual(messages.map(m => m.type), ['TranscriptInterim', 'TranscriptEndpoint']);
            assert.equal(capturedRequests.length, 1); // Did NOT call Gemini
            console.log('PASS: silence stream skips Gemini without hallucination');
        }

        // 7. HTTPS CONNECT api.anthropic.com:443 TLS tunnel with generated CA
        {
            assert.ok(caPath && fs.existsSync(caPath), 'CA cert must be generated');
            const ca = fs.readFileSync(caPath);

            const rawSocket = net.connect(port, '127.0.0.1');
            await new Promise((resolve, reject) => {
                rawSocket.once('connect', resolve);
                rawSocket.once('error', reject);
            });

            rawSocket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
            await new Promise((resolve, reject) => {
                let buf = '';
                const onData = (chunk) => {
                    buf += chunk.toString('utf8');
                    if (buf.includes('\r\n\r\n')) {
                        rawSocket.off('data', onData);
                        assert.match(buf, /^HTTP\/1\.1 200 Connection Established/i);
                        resolve();
                    }
                };
                rawSocket.on('data', onData);
                rawSocket.once('error', reject);
            });

            const tlsSocket = tls.connect({
                socket: rawSocket,
                servername: 'api.anthropic.com',
                ca,
                rejectUnauthorized: true
            });
            await new Promise((resolve, reject) => {
                tlsSocket.once('secureConnect', resolve);
                tlsSocket.once('error', reject);
            });

            const messages = await runWsOverSocket(
                tlsSocket,
                'api.anthropic.com',
                `${VOICE_STREAM_PATH}?encoding=linear16&sample_rate=16000&channels=1&language=es`,
                buildTonePcm(0.4)
            );
            assert.deepEqual(messages.map(m => m.type), ['TranscriptInterim', 'TranscriptText', 'TranscriptEndpoint']);
            assert.equal(messages[1].data, 'Probando transcripcion por voz.');
            assert.equal(capturedRequests.length, 2);
            tlsSocket.destroy();
            rawSocket.destroy();
            console.log('PASS: CONNECT api.anthropic.com:443 TLS WebSocket tunnel verified with CA');
        }

        // 8. Non-Anthropic CONNECT uses raw TCP passthrough
        {
            const echoServer = net.createServer((sock) => {
                sock.once('data', (d) => sock.end(Buffer.concat([Buffer.from('ECHO:'), d])));
            });
            await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
            const echoPort = echoServer.address().port;

            try {
                const rawSocket = net.connect(port, '127.0.0.1');
                await new Promise((resolve, reject) => {
                    rawSocket.once('connect', resolve);
                    rawSocket.once('error', reject);
                });
                rawSocket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);

                const response = await new Promise((resolve, reject) => {
                    let hdrDone = false;
                    let buf = Buffer.alloc(0);
                    let body = Buffer.alloc(0);
                    rawSocket.on('data', (chunk) => {
                        if (!hdrDone) {
                            buf = Buffer.concat([buf, chunk]);
                            const idx = buf.indexOf('\r\n\r\n');
                            if (idx !== -1) {
                                assert.match(buf.subarray(0, idx).toString('utf8'), /^HTTP\/1\.1 200 Connection Established/i);
                                hdrDone = true;
                                body = buf.subarray(idx + 4);
                                rawSocket.write('hello-tunnel');
                            }
                        } else {
                            body = Buffer.concat([body, chunk]);
                        }
                    });
                    rawSocket.on('end', () => resolve(body.toString('utf8')));
                    rawSocket.once('error', reject);
                });

                assert.equal(response, 'ECHO:hello-tunnel');
                rawSocket.destroy();
                console.log('PASS: non-Anthropic CONNECT raw TCP passthrough');
            } finally {
                await new Promise((resolve) => echoServer.close(resolve));
            }
        }
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tempCertDir, { recursive: true, force: true });
    }

    console.log('All 8 voice stream tests passed');
}

runTests()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
